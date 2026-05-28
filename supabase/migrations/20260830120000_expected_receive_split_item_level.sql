-- Item-level receive split: one return_items row = one allocated unit.
-- Blocks quantity-only scanner receive (return_item_ids required).

BEGIN;

-- ── return_items.expected_item_id (idempotent) ───────────────────────────────
ALTER TABLE public.return_items
  ADD COLUMN IF NOT EXISTS expected_item_id uuid;

DO $$
BEGIN
  IF to_regclass('public.expected_packages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_items_expected_item_id_fkey') THEN
    ALTER TABLE public.return_items
      ADD CONSTRAINT return_items_expected_item_id_fkey
      FOREIGN KEY (expected_item_id) REFERENCES public.expected_packages (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_return_items_expected_item_id
  ON public.return_items (expected_item_id)
  WHERE expected_item_id IS NOT NULL;

COMMENT ON COLUMN public.return_items.expected_item_id IS
  'receive_allocated expected_packages.id for this physical scanned unit (one row = one item).';

-- ── Helpers ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._receive_split_resolve_root(
  p_organization_id uuid,
  p_store_id        uuid,
  p_ep_id           uuid
)
RETURNS public.expected_packages
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_walk_id uuid := p_ep_id;
  v_row     public.expected_packages%ROWTYPE;
  v_guard   integer := 0;
BEGIN
  LOOP
    SELECT * INTO v_row
    FROM public.expected_packages ep
    WHERE ep.id = v_walk_id
      AND ep.organization_id = p_organization_id
      AND ep.store_id IS NOT DISTINCT FROM p_store_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'expected_packages row not found: %', p_ep_id;
    END IF;
    IF v_row.build_source = 'receive_allocated' AND v_row.parent_expected_package_id IS NOT NULL THEN
      v_walk_id := v_row.parent_expected_package_id;
      v_guard := v_guard + 1;
      IF v_guard > 16 THEN
        RAISE EXCEPTION 'parent chain too deep';
      END IF;
      CONTINUE;
    END IF;
    EXIT;
  END LOOP;
  IF v_row.build_source NOT IN ('detail_shipment', 'detail_remainder', 'legacy') THEN
    RAISE EXCEPTION 'root row is not Amazon-derived: %', v_row.build_source;
  END IF;
  RETURN v_row;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._receive_split_scope_key(
  p_entity_type       text,
  p_id_slip_contents  text,
  p_package_id        uuid,
  p_pallet_id         uuid
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
  SELECT concat_ws('|',
    lower(btrim(COALESCE(p_entity_type, 'box'))),
    btrim(COALESCE(p_id_slip_contents, '')),
    COALESCE(p_package_id::text, ''),
    COALESCE(p_pallet_id::text, '')
  );
$fn$;

-- ── Allocate exactly one unit for one return_items row ────────────────────────
CREATE OR REPLACE FUNCTION public.allocate_expected_item_unit(
  p_organization_id       uuid,
  p_store_id              uuid,
  p_parent_ep_id          uuid,
  p_return_item_id        uuid,
  p_entity_type           text DEFAULT NULL,
  p_id_slip_contents      text DEFAULT NULL,
  p_package_id            uuid DEFAULT NULL,
  p_pallet_id             uuid DEFAULT NULL,
  p_idempotency_key       uuid DEFAULT NULL
)
RETURNS TABLE (
  allocated_ep_id uuid,
  parent_ep_id    uuid,
  remainder_qty   integer,
  overage_qty     integer,
  ok              boolean,
  message         text
)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_root          public.expected_packages%ROWTYPE;
  v_root_id       uuid;
  v_scope_key     text;
  v_allocated_id  uuid;
  v_remaining     integer;
  v_ri            public.return_items%ROWTYPE;
BEGIN
  IF p_return_item_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 0, false, 'return_item_id required';
    RETURN;
  END IF;

  SELECT * INTO v_ri
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id
    AND ri.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 0, false, 'return_items row not found';
    RETURN;
  END IF;

  IF v_ri.expected_item_id IS NOT NULL THEN
    SELECT ep.expected_scan_quantity INTO v_remaining
    FROM public.expected_packages ep
    WHERE ep.id = (
      SELECT COALESCE(r.parent_expected_package_id, r.id)
      FROM public.expected_packages r
      WHERE r.id = v_ri.expected_item_id
    );
    RETURN QUERY SELECT v_ri.expected_item_id,
      (SELECT COALESCE(r.parent_expected_package_id, r.id)
       FROM public.expected_packages r WHERE r.id = v_ri.expected_item_id),
      COALESCE(v_remaining, 0), 0, true, 'already_allocated';
    RETURN;
  END IF;

  v_root := public._receive_split_resolve_root(p_organization_id, p_store_id, p_parent_ep_id);
  v_root_id := v_root.id;
  v_scope_key := public._receive_split_scope_key(
    p_entity_type, p_id_slip_contents, p_package_id, p_pallet_id
  );

  SELECT ep.id INTO v_allocated_id
  FROM public.expected_packages ep
  WHERE ep.organization_id = p_organization_id
    AND ep.parent_expected_package_id = v_root_id
    AND ep.receive_scope_key IS NOT DISTINCT FROM v_scope_key
    AND ep.build_source = 'receive_allocated'
  LIMIT 1
  FOR UPDATE;

  IF v_allocated_id IS NOT NULL THEN
    UPDATE public.expected_packages ep
    SET expected_scan_quantity = COALESCE(ep.expected_scan_quantity, 0) + 1,
        actual_scanned_count = COALESCE(ep.actual_scanned_count, 0) + 1,
        id_slip_contents = COALESCE(ep.id_slip_contents, NULLIF(btrim(p_id_slip_contents), '')),
        updated_at = now()
    WHERE ep.id = v_allocated_id;

    UPDATE public.expected_packages ep
    SET expected_scan_quantity = GREATEST(COALESCE(ep.expected_scan_quantity, 0) - 1, 0),
        updated_at = now()
    WHERE ep.id = v_root_id;

    UPDATE public.return_items ri
    SET expected_item_id = v_allocated_id,
        updated_at = now()
    WHERE ri.id = p_return_item_id;

    SELECT ep.expected_scan_quantity INTO v_remaining
    FROM public.expected_packages ep WHERE ep.id = v_root_id;

    RETURN QUERY SELECT v_allocated_id, v_root_id, COALESCE(v_remaining, 0), 0, true, 'scope_increment';
    RETURN;
  END IF;

  v_remaining := GREATEST(COALESCE(v_root.expected_scan_quantity, 0), 0);
  IF v_remaining < 1 THEN
    RETURN QUERY SELECT NULL::uuid, v_root_id, v_remaining, 1, true, 'overage_only';
    RETURN;
  END IF;

  INSERT INTO public.expected_packages (
    organization_id, store_id, upload_id,
    order_id, order_type, order_date, sku, fnsku, disposition,
    requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
    in_process_quantity, removal_fee, currency, order_status,
    tracking_number, carrier, shipment_date,
    source_detail_row_id, source_shipment_row_id, source_shipment_row_ids,
    detail_shipped_quantity_total, shipment_row_quantity, expected_scan_quantity,
    allocation_group_key, build_source, build_status, detail_grouping_key,
    actual_scanned_count, id_slip_contents,
    resolved_product_id, resolved_catalog_product_id,
    identifier_resolution_status, identifier_resolution_confidence,
    parent_expected_package_id, receive_scope_key, receive_entity_type,
    allocated_package_id, allocated_pallet_id, receive_idempotency_key
  )
  VALUES (
    v_root.organization_id, v_root.store_id, v_root.upload_id,
    v_root.order_id, v_root.order_type, v_root.order_date, v_root.sku, v_root.fnsku, v_root.disposition,
    v_root.requested_quantity, v_root.shipped_quantity, v_root.disposed_quantity, v_root.cancelled_quantity,
    v_root.in_process_quantity, v_root.removal_fee, v_root.currency, v_root.order_status,
    v_root.tracking_number, v_root.carrier, v_root.shipment_date,
    v_root.source_detail_row_id, v_root.source_shipment_row_id, v_root.source_shipment_row_ids,
    v_root.detail_shipped_quantity_total, v_root.shipment_row_quantity, 1,
    v_root.allocation_group_key, 'receive_allocated', 'received',
    v_root.detail_grouping_key,
    1, NULLIF(btrim(p_id_slip_contents), ''),
    v_root.resolved_product_id, v_root.resolved_catalog_product_id,
    v_root.identifier_resolution_status, v_root.identifier_resolution_confidence,
    v_root_id, v_scope_key, lower(btrim(COALESCE(p_entity_type, 'box'))),
    p_package_id, p_pallet_id, p_idempotency_key
  )
  RETURNING id INTO v_allocated_id;

  UPDATE public.expected_packages ep
  SET expected_scan_quantity = GREATEST(COALESCE(ep.expected_scan_quantity, 0) - 1, 0),
      updated_at = now()
  WHERE ep.id = v_root_id;

  UPDATE public.return_items ri
  SET expected_item_id = v_allocated_id,
      updated_at = now()
  WHERE ri.id = p_return_item_id;

  SELECT ep.expected_scan_quantity INTO v_remaining
  FROM public.expected_packages ep WHERE ep.id = v_root_id;

  RETURN QUERY SELECT v_allocated_id, v_root_id, COALESCE(v_remaining, 0), 0, true, 'unit_allocated';
END;
$fn$;

-- ── Batch: one unit per return_item id ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.allocate_expected_items_for_return_item_ids(
  p_organization_id       uuid,
  p_store_id              uuid,
  p_parent_ep_id          uuid,
  p_return_item_ids       uuid[],
  p_entity_type           text DEFAULT NULL,
  p_id_slip_contents      text DEFAULT NULL,
  p_package_id            uuid DEFAULT NULL,
  p_pallet_id             uuid DEFAULT NULL,
  p_idempotency_key       uuid DEFAULT NULL
)
RETURNS TABLE (
  allocated_ep_id uuid,
  parent_ep_id    uuid,
  remainder_qty   integer,
  overage_qty     integer,
  ok              boolean,
  message         text
)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_id      uuid;
  v_last    record;
  v_total_overage integer := 0;
BEGIN
  IF p_return_item_ids IS NULL OR array_length(p_return_item_ids, 1) IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 0, false, 'return_item_ids required';
    RETURN;
  END IF;

  FOREACH v_id IN ARRAY p_return_item_ids LOOP
    SELECT * INTO v_last
    FROM public.allocate_expected_item_unit(
      p_organization_id, p_store_id, p_parent_ep_id, v_id,
      p_entity_type, p_id_slip_contents, p_package_id, p_pallet_id,
      p_idempotency_key
    ) AS t(allocated_ep_id, parent_ep_id, remainder_qty, overage_qty, ok, message);
    IF NOT v_last.ok AND v_last.message NOT IN ('overage_only', 'already_allocated') THEN
      RETURN QUERY SELECT v_last.allocated_ep_id, v_last.parent_ep_id, v_last.remainder_qty,
        v_last.overage_qty, false, v_last.message;
      RETURN;
    END IF;
    v_total_overage := v_total_overage + COALESCE(v_last.overage_qty, 0);
  END LOOP;

  RETURN QUERY SELECT v_last.allocated_ep_id, v_last.parent_ep_id, v_last.remainder_qty,
    v_total_overage, true, 'batch_ok';
END;
$fn$;

-- ── Release one unit when return_items row is removed ───────────────────────
CREATE OR REPLACE FUNCTION public.release_expected_item_unit(
  p_organization_id uuid,
  p_return_item_id  uuid
)
RETURNS TABLE (ok boolean, message text)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_ri            public.return_items%ROWTYPE;
  v_alloc         public.expected_packages%ROWTYPE;
  v_root_id       uuid;
  v_new_qty       integer;
BEGIN
  SELECT * INTO v_ri
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id AND ri.organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND OR v_ri.expected_item_id IS NULL THEN
    RETURN QUERY SELECT true, 'nothing_to_release';
    RETURN;
  END IF;

  SELECT * INTO v_alloc
  FROM public.expected_packages ep
  WHERE ep.id = v_ri.expected_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.return_items SET expected_item_id = NULL WHERE id = p_return_item_id;
    RETURN QUERY SELECT true, 'alloc_row_missing_cleared';
    RETURN;
  END IF;

  v_root_id := v_alloc.parent_expected_package_id;
  v_new_qty := GREATEST(COALESCE(v_alloc.expected_scan_quantity, 0) - 1, 0);

  IF v_new_qty = 0 THEN
    DELETE FROM public.expected_packages WHERE id = v_alloc.id;
  ELSE
    UPDATE public.expected_packages
    SET expected_scan_quantity = v_new_qty,
        actual_scanned_count = GREATEST(COALESCE(actual_scanned_count, 0) - 1, 0),
        updated_at = now()
    WHERE id = v_alloc.id;
  END IF;

  IF v_root_id IS NOT NULL THEN
    UPDATE public.expected_packages
    SET expected_scan_quantity = COALESCE(expected_scan_quantity, 0) + 1,
        updated_at = now()
    WHERE id = v_root_id;
  END IF;

  UPDATE public.return_items
  SET expected_item_id = NULL, updated_at = now()
  WHERE id = p_return_item_id;

  RETURN QUERY SELECT true, 'released';
END;
$fn$;

-- ── Move one unit to a new receive scope ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.move_expected_item_unit(
  p_organization_id       uuid,
  p_store_id              uuid,
  p_return_item_id        uuid,
  p_entity_type           text DEFAULT NULL,
  p_id_slip_contents      text DEFAULT NULL,
  p_package_id            uuid DEFAULT NULL,
  p_pallet_id             uuid DEFAULT NULL
)
RETURNS TABLE (
  allocated_ep_id uuid,
  parent_ep_id    uuid,
  remainder_qty   integer,
  overage_qty     integer,
  ok              boolean,
  message         text
)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_parent_id uuid;
  v_rel       record;
BEGIN
  SELECT COALESCE(a.parent_expected_package_id, a.id) INTO v_parent_id
  FROM public.return_items ri
  JOIN public.expected_packages a ON a.id = ri.expected_item_id
  WHERE ri.id = p_return_item_id AND ri.organization_id = p_organization_id;

  IF v_parent_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 0, false, 'not_allocated';
    RETURN;
  END IF;

  SELECT * INTO v_rel FROM public.release_expected_item_unit(p_organization_id, p_return_item_id) AS t(ok, message);
  IF NOT v_rel.ok THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 0, false, v_rel.message;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT * FROM public.allocate_expected_item_unit(
    p_organization_id, p_store_id, v_parent_id, p_return_item_id,
    p_entity_type, p_id_slip_contents, p_package_id, p_pallet_id, NULL
  ) AS t(allocated_ep_id, parent_ep_id, remainder_qty, overage_qty, ok, message);
END;
$fn$;

-- Drop legacy overloads before replacing receive_expected_item_with_split
DROP FUNCTION IF EXISTS public.receive_expected_item_with_split(
  uuid, uuid, uuid, integer, text, text, uuid, uuid, uuid, uuid[]
);

-- ── Replace bulk split: require return_item_ids (qty-only blocked for scanner) ─
CREATE OR REPLACE FUNCTION public.receive_expected_item_with_split(
  p_organization_id       uuid,
  p_store_id              uuid,
  p_parent_ep_id          uuid,
  p_received_qty          integer,
  p_entity_type           text DEFAULT NULL,
  p_id_slip_contents      text DEFAULT NULL,
  p_package_id            uuid DEFAULT NULL,
  p_pallet_id             uuid DEFAULT NULL,
  p_idempotency_key       uuid DEFAULT NULL,
  p_return_item_ids       uuid[] DEFAULT NULL,
  p_allow_qty_only        boolean DEFAULT false
)
RETURNS TABLE (
  allocated_ep_id uuid,
  parent_ep_id    uuid,
  remainder_qty   integer,
  overage_qty     integer,
  ok              boolean,
  message         text
)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_n integer;
BEGIN
  v_n := COALESCE(array_length(p_return_item_ids, 1), 0);

  IF v_n = 0 THEN
    IF COALESCE(p_allow_qty_only, false) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 0, false,
        'qty_only_deprecated_use_allocate_expected_item_unit';
      RETURN;
    END IF;
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 0, false,
      'return_item_ids required — quantity-only receive blocked for scanner';
    RETURN;
  END IF;

  IF p_received_qty IS NOT NULL AND p_received_qty <> v_n THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 0, false,
      format('p_received_qty (%s) must equal return_item_ids count (%s)', p_received_qty, v_n);
    RETURN;
  END IF;

  RETURN QUERY
  SELECT * FROM public.allocate_expected_items_for_return_item_ids(
    p_organization_id, p_store_id, p_parent_ep_id, p_return_item_ids,
    p_entity_type, p_id_slip_contents, p_package_id, p_pallet_id, p_idempotency_key
  ) AS t(allocated_ep_id, parent_ep_id, remainder_qty, overage_qty, ok, message);
END;
$fn$;

COMMENT ON FUNCTION public.allocate_expected_item_unit IS
  'Allocate one expected_packages unit to one return_items row (receive_allocated scope).';

GRANT EXECUTE ON FUNCTION public.allocate_expected_item_unit(
  uuid, uuid, uuid, uuid, text, text, uuid, uuid, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.allocate_expected_items_for_return_item_ids(
  uuid, uuid, uuid, uuid[], text, text, uuid, uuid, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_expected_item_unit(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.move_expected_item_unit(
  uuid, uuid, uuid, text, text, uuid, uuid
) TO service_role;

COMMENT ON FUNCTION public.receive_expected_item_with_split(
  uuid, uuid, uuid, integer, text, text, uuid, uuid, uuid, uuid[], boolean
) IS 'Item-level receive: requires p_return_item_ids; delegates to allocate_expected_items_for_return_item_ids.';

GRANT EXECUTE ON FUNCTION public.receive_expected_item_with_split(
  uuid, uuid, uuid, integer, text, text, uuid, uuid, uuid, uuid[], boolean
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
