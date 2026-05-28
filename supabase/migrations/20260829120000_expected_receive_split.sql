-- Expected receive split: partial slip/package allocation on expected_packages.
-- build_source receive_allocated = operator-allocated slice; parent row holds unassigned remainder.
-- NOTE: Item-level scanner receive (one return_items row = one unit) is enforced in
--       20260830120000_expected_receive_split_item_level.sql (replaces qty-only split).

BEGIN;

ALTER TABLE public.expected_packages
  ADD COLUMN IF NOT EXISTS parent_expected_package_id uuid,
  ADD COLUMN IF NOT EXISTS receive_scope_key text,
  ADD COLUMN IF NOT EXISTS receive_entity_type text,
  ADD COLUMN IF NOT EXISTS allocated_package_id uuid,
  ADD COLUMN IF NOT EXISTS allocated_pallet_id uuid,
  ADD COLUMN IF NOT EXISTS receive_idempotency_key uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expected_packages_parent_expected_package_id_fkey'
  ) THEN
    ALTER TABLE public.expected_packages
      ADD CONSTRAINT expected_packages_parent_expected_package_id_fkey
      FOREIGN KEY (parent_expected_package_id)
      REFERENCES public.expected_packages (id)
      ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.packages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expected_packages_allocated_package_id_fkey') THEN
    ALTER TABLE public.expected_packages
      ADD CONSTRAINT expected_packages_allocated_package_id_fkey
      FOREIGN KEY (allocated_package_id)
      REFERENCES public.packages (id)
      ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.pallets') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expected_packages_allocated_pallet_id_fkey') THEN
    ALTER TABLE public.expected_packages
      ADD CONSTRAINT expected_packages_allocated_pallet_id_fkey
      FOREIGN KEY (allocated_pallet_id)
      REFERENCES public.pallets (id)
      ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.expected_packages.parent_expected_package_id IS
  'Root Amazon-derived EP row for receive_allocated children; NULL on root/legacy rows.';
COMMENT ON COLUMN public.expected_packages.receive_scope_key IS
  'Stable scope: entity_type|slip|package_id|pallet_id for receive_allocated uniqueness.';
COMMENT ON COLUMN public.expected_packages.receive_entity_type IS
  'box | pallet — operator entity that claimed this allocated slice.';
COMMENT ON COLUMN public.expected_packages.receive_idempotency_key IS
  'Client idempotency UUID; duplicate calls return the same allocated row.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_expected_packages_receive_allocated_scope
  ON public.expected_packages (
    organization_id, parent_expected_package_id, receive_scope_key
  )
  WHERE build_source = 'receive_allocated'
    AND parent_expected_package_id IS NOT NULL
    AND receive_scope_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_expected_packages_receive_idempotency
  ON public.expected_packages (organization_id, receive_idempotency_key)
  WHERE build_source = 'receive_allocated'
    AND receive_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expected_packages_receive_parent
  ON public.expected_packages (parent_expected_package_id)
  WHERE build_source = 'receive_allocated';

-- ── Transactional split on partial receive ───────────────────────────────────
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
  p_return_item_ids       uuid[] DEFAULT NULL
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
  v_root              public.expected_packages%ROWTYPE;
  v_root_id           uuid;
  v_scope_key         text;
  v_remaining         integer;
  v_effective         integer;
  v_overage           integer;
  v_allocated_id      uuid;
  v_scanned           integer;
  v_existing          uuid;
  v_walk_id           uuid;
  v_guard             integer := 0;
BEGIN
  IF p_received_qty IS NULL OR p_received_qty < 1 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 0, false, 'received_qty must be >= 1';
    RETURN;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT ep.id INTO v_existing
    FROM public.expected_packages ep
    WHERE ep.organization_id = p_organization_id
      AND ep.receive_idempotency_key = p_idempotency_key
      AND ep.build_source = 'receive_allocated'
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
      SELECT ep.expected_scan_quantity INTO v_remaining
      FROM public.expected_packages ep
      WHERE ep.id = (
        SELECT COALESCE(r.parent_expected_package_id, r.id)
        FROM public.expected_packages r
        WHERE r.id = v_existing
      );
      RETURN QUERY SELECT v_existing, (
        SELECT COALESCE(r.parent_expected_package_id, r.id)
        FROM public.expected_packages r WHERE r.id = v_existing
      ), COALESCE(v_remaining, 0), 0, true, 'idempotent_hit';
      RETURN;
    END IF;
  END IF;

  v_walk_id := p_parent_ep_id;
  LOOP
    SELECT * INTO v_root
    FROM public.expected_packages ep
    WHERE ep.id = v_walk_id
      AND ep.organization_id = p_organization_id
      AND ep.store_id IS NOT DISTINCT FROM p_store_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 0, false, 'expected_packages row not found';
      RETURN;
    END IF;
    IF v_root.build_source = 'receive_allocated' AND v_root.parent_expected_package_id IS NOT NULL THEN
      v_walk_id := v_root.parent_expected_package_id;
      v_guard := v_guard + 1;
      IF v_guard > 16 THEN
        RETURN QUERY SELECT NULL::uuid, NULL::uuid, 0, 0, false, 'parent chain too deep';
        RETURN;
      END IF;
      CONTINUE;
    END IF;
    EXIT;
  END LOOP;

  v_root_id := v_root.id;

  IF v_root.build_source NOT IN ('detail_shipment', 'detail_remainder', 'legacy') THEN
    RETURN QUERY SELECT NULL::uuid, v_root_id, 0, 0, false, 'root row is not Amazon-derived';
    RETURN;
  END IF;

  v_scope_key := concat_ws('|',
    lower(btrim(COALESCE(p_entity_type, 'box'))),
    btrim(COALESCE(p_id_slip_contents, '')),
    COALESCE(p_package_id::text, ''),
    COALESCE(p_pallet_id::text, '')
  );

  SELECT ep.id INTO v_existing
  FROM public.expected_packages ep
  WHERE ep.organization_id = p_organization_id
    AND ep.parent_expected_package_id = v_root_id
    AND ep.receive_scope_key IS NOT DISTINCT FROM v_scope_key
    AND ep.build_source = 'receive_allocated'
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    v_scanned := COALESCE(array_length(p_return_item_ids, 1), p_received_qty);
    UPDATE public.expected_packages ep
    SET actual_scanned_count = GREATEST(COALESCE(ep.actual_scanned_count, 0), v_scanned),
        id_slip_contents = COALESCE(ep.id_slip_contents, NULLIF(btrim(p_id_slip_contents), '')),
        updated_at = now()
    WHERE ep.id = v_existing;

    IF p_return_item_ids IS NOT NULL THEN
      UPDATE public.return_items ri
      SET expected_item_id = v_existing,
          expected_product_id = COALESCE(ri.expected_product_id, v_root.resolved_product_id)
      WHERE ri.id = ANY (p_return_item_ids)
        AND ri.organization_id = p_organization_id;
    END IF;

    RETURN QUERY SELECT v_existing, v_root_id, v_root.expected_scan_quantity, 0, true, 'scope_exists';
    RETURN;
  END IF;

  v_remaining := GREATEST(COALESCE(v_root.expected_scan_quantity, 0), 0);
  v_effective := LEAST(p_received_qty, v_remaining);
  v_overage := GREATEST(p_received_qty - v_remaining, 0);

  IF v_effective = 0 THEN
    RETURN QUERY SELECT NULL::uuid, v_root_id, v_remaining, v_overage, true,
      CASE WHEN v_overage > 0 THEN 'overage_only' ELSE 'nothing_to_allocate' END;
    RETURN;
  END IF;

  v_scanned := COALESCE(array_length(p_return_item_ids, 1), v_effective);

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
    v_root.detail_shipped_quantity_total, v_root.shipment_row_quantity, v_effective,
    v_root.allocation_group_key, 'receive_allocated', 'received',
    v_root.detail_grouping_key,
    v_scanned, NULLIF(btrim(p_id_slip_contents), ''),
    v_root.resolved_product_id, v_root.resolved_catalog_product_id,
    v_root.identifier_resolution_status, v_root.identifier_resolution_confidence,
    v_root_id, v_scope_key, lower(btrim(COALESCE(p_entity_type, 'box'))),
    p_package_id, p_pallet_id, p_idempotency_key
  )
  RETURNING id INTO v_allocated_id;

  UPDATE public.expected_packages ep
  SET expected_scan_quantity = GREATEST(COALESCE(ep.expected_scan_quantity, 0) - v_effective, 0),
      updated_at = now()
  WHERE ep.id = v_root_id;

  IF p_return_item_ids IS NOT NULL THEN
    UPDATE public.return_items ri
    SET expected_item_id = v_allocated_id,
        expected_product_id = COALESCE(ri.expected_product_id, v_root.resolved_product_id)
    WHERE ri.id = ANY (p_return_item_ids)
      AND ri.organization_id = p_organization_id;
  END IF;

  SELECT ep.expected_scan_quantity INTO v_remaining
  FROM public.expected_packages ep
  WHERE ep.id = v_root_id;

  RETURN QUERY SELECT v_allocated_id, v_root_id, COALESCE(v_remaining, 0), v_overage, true, 'split_ok';
END;
$fn$;

COMMENT ON FUNCTION public.receive_expected_item_with_split IS
  'Split root expected_packages row on partial receive: receive_allocated child + shrunk remainder on root.';

GRANT EXECUTE ON FUNCTION public.receive_expected_item_with_split(
  uuid, uuid, uuid, integer, text, text, uuid, uuid, uuid, uuid[]
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
