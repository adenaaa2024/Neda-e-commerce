-- EXPECTED-RECEIVE-SPLIT-ITEM-LEVEL
-- Item-level receive allocation: one return_items row -> one unit from expected_packages remainder
-- into a receive_allocated child row per receive_scope_key. No quantity_entered on return_items.

-- Clean prior overloads (staging repair idempotency)
DROP FUNCTION IF EXISTS public.allocate_expected_item_unit(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid
);
DROP FUNCTION IF EXISTS public.allocate_expected_items_for_return_item_ids(uuid[], uuid, text);
DROP FUNCTION IF EXISTS public.allocate_expected_items_for_return_item_ids(uuid[]);
DROP FUNCTION IF EXISTS public.release_expected_item_unit(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.move_expected_item_unit(uuid, uuid, uuid, uuid, text, text, text, uuid);

BEGIN;

ALTER TABLE public.expected_packages
  ADD COLUMN IF NOT EXISTS parent_expected_package_id uuid,
  ADD COLUMN IF NOT EXISTS receive_scope_key text,
  ADD COLUMN IF NOT EXISTS allocated_package_id uuid,
  ADD COLUMN IF NOT EXISTS allocated_pallet_id uuid,
  ADD COLUMN IF NOT EXISTS receive_entity_type text;

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
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'expected_packages_allocated_package_id_fkey'
     ) THEN
    ALTER TABLE public.expected_packages
      ADD CONSTRAINT expected_packages_allocated_package_id_fkey
      FOREIGN KEY (allocated_package_id)
      REFERENCES public.packages (id)
      ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.pallets') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'expected_packages_allocated_pallet_id_fkey'
     ) THEN
    ALTER TABLE public.expected_packages
      ADD CONSTRAINT expected_packages_allocated_pallet_id_fkey
      FOREIGN KEY (allocated_pallet_id)
      REFERENCES public.pallets (id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_expected_packages_parent
  ON public.expected_packages (parent_expected_package_id)
  WHERE parent_expected_package_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expected_packages_receive_scope
  ON public.expected_packages (organization_id, store_id, receive_scope_key)
  WHERE build_source = 'receive_allocated';

COMMENT ON COLUMN public.expected_packages.receive_scope_key IS
  'Stable receive allocation bucket: org|store|package_id|slip|entity.';
COMMENT ON COLUMN public.expected_packages.parent_expected_package_id IS
  'Root expected_packages row (remainder/shipment) this receive_allocated child draws from.';

-- ── helpers ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._normalize_tracking_token(p_tracking text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT NULLIF(
    trim(both ' []"' FROM split_part(COALESCE(p_tracking, ''), ',', 1)),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION public._ep_build_source_rank(p_build_source text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE COALESCE(p_build_source, 'legacy')
    WHEN 'detail_remainder' THEN 1
    WHEN 'detail_shipment'  THEN 2
    ELSE 3
  END;
$$;

-- ── allocate one unit ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.allocate_expected_item_unit(
  p_return_item_id        uuid,
  p_organization_id       uuid,
  p_store_id              uuid,
  p_package_id            uuid,
  p_receive_scope_key     text,
  p_order_id              text,
  p_tracking_number       text,
  p_disposition           text,
  p_sku                   text,
  p_fnsku                 text,
  p_upc                   text,
  p_asin                  text,
  p_resolved_product_id   uuid,
  p_expected_package_hint uuid
)
RETURNS TABLE (
  allocated_expected_package_id uuid,
  parent_expected_package_id    uuid,
  product_match_status          text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_existing_ep       uuid;
  v_parent            public.expected_packages%ROWTYPE;
  v_child_id          uuid;
  v_slip              text;
  v_pallet_id         uuid;
  v_expected_product  uuid;
  v_scanned_product   uuid;
  v_match_status      text;
  v_norm_tracking     text;
BEGIN
  SELECT ri.expected_item_id, ri.resolved_product_id
    INTO v_existing_ep, v_scanned_product
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id
    AND ri.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_item_not_found';
  END IF;

  IF v_existing_ep IS NOT NULL THEN
    SELECT ep.parent_expected_package_id
      INTO parent_expected_package_id
    FROM public.expected_packages ep
    WHERE ep.id = v_existing_ep;

    allocated_expected_package_id := v_existing_ep;
    product_match_status := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  v_norm_tracking := public._normalize_tracking_token(p_tracking_number);

  IF p_expected_package_hint IS NOT NULL THEN
    SELECT ep.*
      INTO v_parent
    FROM public.expected_packages ep
    WHERE ep.id = p_expected_package_hint
      AND ep.organization_id = p_organization_id
      AND ep.store_id = p_store_id
      AND ep.parent_expected_package_id IS NULL
      AND COALESCE(ep.expected_scan_quantity, 0) >= 1
    FOR UPDATE;
  END IF;

  IF v_parent.id IS NULL THEN
    SELECT ep.*
      INTO v_parent
    FROM public.expected_packages ep
    WHERE ep.organization_id = p_organization_id
      AND ep.store_id = p_store_id
      AND ep.parent_expected_package_id IS NULL
      AND COALESCE(ep.build_source, 'legacy') <> 'receive_allocated'
      AND COALESCE(ep.expected_scan_quantity, 0) >= 1
      AND (p_order_id IS NULL OR ep.order_id IS NOT DISTINCT FROM p_order_id)
      AND (
        v_norm_tracking IS NULL
        OR public._normalize_tracking_token(ep.tracking_number) IS NOT DISTINCT FROM v_norm_tracking
      )
      AND (p_disposition IS NULL OR btrim(COALESCE(p_disposition, '')) = '' OR ep.disposition IS NOT DISTINCT FROM p_disposition)
      AND (
        (p_sku IS NOT NULL AND btrim(p_sku) <> '' AND lower(btrim(ep.sku)) = lower(btrim(p_sku)))
        OR (p_fnsku IS NOT NULL AND btrim(p_fnsku) <> '' AND lower(btrim(ep.fnsku)) = lower(btrim(p_fnsku)))
      )
      AND (
        p_resolved_product_id IS NULL
        OR ep.resolved_product_id IS NULL
        OR ep.resolved_product_id = p_resolved_product_id
      )
    ORDER BY public._ep_build_source_rank(ep.build_source), ep.expected_scan_quantity DESC, ep.id
    LIMIT 1
    FOR UPDATE;
  END IF;

  IF v_parent.id IS NULL OR COALESCE(v_parent.expected_scan_quantity, 0) < 1 THEN
    RAISE EXCEPTION 'no_allocatable_expected';
  END IF;

  IF p_package_id IS NOT NULL THEN
    SELECT p.id_slip_contents, p.pallet_id
      INTO v_slip, v_pallet_id
    FROM public.packages p
    WHERE p.id = p_package_id
      AND p.organization_id = p_organization_id;
  END IF;

  SELECT ep.id
    INTO v_child_id
  FROM public.expected_packages ep
  WHERE ep.parent_expected_package_id = v_parent.id
    AND ep.build_source = 'receive_allocated'
    AND ep.receive_scope_key IS NOT DISTINCT FROM p_receive_scope_key
  FOR UPDATE;

  IF v_child_id IS NOT NULL THEN
    UPDATE public.expected_packages
      SET expected_scan_quantity = COALESCE(expected_scan_quantity, 0) + 1,
          updated_at = now()
    WHERE id = v_child_id;
  ELSE
    INSERT INTO public.expected_packages (
      organization_id, store_id, upload_id,
      order_id, order_type, order_date,
      sku, fnsku, disposition,
      requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
      order_status, tracking_number, carrier, shipment_date,
      source_detail_row_id, source_shipment_row_id,
      detail_shipped_quantity_total, shipment_row_quantity,
      expected_scan_quantity, build_source, build_status, detail_grouping_key,
      parent_expected_package_id, receive_scope_key,
      allocated_package_id, allocated_pallet_id, id_slip_contents,
      resolved_product_id
    )
    VALUES (
      v_parent.organization_id, v_parent.store_id, v_parent.upload_id,
      v_parent.order_id, v_parent.order_type, v_parent.order_date,
      COALESCE(NULLIF(btrim(p_sku), ''), v_parent.sku),
      COALESCE(NULLIF(btrim(p_fnsku), ''), v_parent.fnsku),
      COALESCE(NULLIF(btrim(p_disposition), ''), v_parent.disposition),
      v_parent.requested_quantity, v_parent.shipped_quantity, v_parent.disposed_quantity, v_parent.cancelled_quantity,
      v_parent.order_status, v_parent.tracking_number, v_parent.carrier, v_parent.shipment_date,
      v_parent.source_detail_row_id, v_parent.source_shipment_row_id,
      v_parent.detail_shipped_quantity_total, v_parent.shipment_row_quantity,
      1, 'receive_allocated', 'matched', v_parent.detail_grouping_key,
      v_parent.id, p_receive_scope_key,
      p_package_id, v_pallet_id, v_slip,
      v_parent.resolved_product_id
    )
    RETURNING id INTO v_child_id;
  END IF;

  UPDATE public.expected_packages
    SET expected_scan_quantity = GREATEST(COALESCE(expected_scan_quantity, 0) - 1, 0),
        updated_at = now()
  WHERE id = v_parent.id;

  v_expected_product := v_parent.resolved_product_id;
  v_scanned_product := COALESCE(p_resolved_product_id, v_scanned_product);
  v_match_status := CASE
    WHEN v_expected_product IS NULL OR v_scanned_product IS NULL THEN NULL
    WHEN v_expected_product = v_scanned_product THEN 'match'
    ELSE 'mismatch'
  END;

  UPDATE public.return_items
    SET expected_item_id = v_child_id,
        updated_at = now()
  WHERE id = p_return_item_id;

  allocated_expected_package_id := v_child_id;
  parent_expected_package_id := v_parent.id;
  product_match_status := v_match_status;
  RETURN NEXT;
END;
$function$;

-- ── batch allocate for inserted return_items ids ────────────────────────────

CREATE OR REPLACE FUNCTION public.allocate_expected_items_for_return_item_ids(
  p_return_item_ids uuid[],
  p_expected_package_hint uuid DEFAULT NULL,
  p_receive_scope_key text DEFAULT NULL
)
RETURNS TABLE (
  return_item_id                uuid,
  allocated_expected_package_id uuid,
  parent_expected_package_id    uuid,
  product_match_status          text,
  error_message                 text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_id uuid;
  v_ri record;
  v_slip text;
  v_tracking text;
  v_scope text;
  v_alloc record;
BEGIN
  FOREACH v_id IN ARRAY COALESCE(p_return_item_ids, ARRAY[]::uuid[])
  LOOP
    return_item_id := v_id;
    error_message := NULL;
    v_slip := NULL;
    v_tracking := NULL;

    SELECT ri.id, ri.organization_id, ri.store_id, ri.package_id, ri.order_id,
           ri.sku, ri.fnsku, ri.asin, ri.product_identifier, ri.resolved_product_id
      INTO v_ri
    FROM public.return_items ri
    WHERE ri.id = v_id;

    IF NOT FOUND THEN
      allocated_expected_package_id := NULL;
      parent_expected_package_id := NULL;
      product_match_status := NULL;
      error_message := 'return_item_not_found';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_ri.package_id IS NOT NULL THEN
      SELECT p.id_slip_contents, p.tracking_number
        INTO v_slip, v_tracking
      FROM public.packages p
      WHERE p.id = v_ri.package_id;
    END IF;

    v_scope := p_receive_scope_key;
    IF v_scope IS NULL OR btrim(v_scope) = '' THEN
      v_scope := concat_ws(
        '|',
        v_ri.organization_id::text,
        v_ri.store_id::text,
        COALESCE(v_ri.package_id::text, ''),
        COALESCE(v_slip, ''),
        'package'
      );
    END IF;

    BEGIN
      SELECT a.allocated_expected_package_id,
             a.parent_expected_package_id,
             a.product_match_status
        INTO v_alloc
      FROM public.allocate_expected_item_unit(
        v_id,
        v_ri.organization_id,
        v_ri.store_id,
        v_ri.package_id,
        v_scope,
        v_ri.order_id,
        v_tracking,
        NULL,
        v_ri.sku,
        v_ri.fnsku,
        v_ri.product_identifier,
        v_ri.asin,
        v_ri.resolved_product_id,
        p_expected_package_hint
      ) a;

      allocated_expected_package_id := v_alloc.allocated_expected_package_id;
      parent_expected_package_id := v_alloc.parent_expected_package_id;
      product_match_status := v_alloc.product_match_status;
    EXCEPTION WHEN OTHERS THEN
      allocated_expected_package_id := NULL;
      parent_expected_package_id := NULL;
      product_match_status := NULL;
      error_message := SQLERRM;
    END;

    RETURN NEXT;
  END LOOP;
END;
$function$;

-- ── release one unit ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.release_expected_item_unit(
  p_return_item_id uuid,
  p_organization_id uuid,
  p_soft_delete boolean DEFAULT true
)
RETURNS TABLE (
  released boolean,
  parent_restored_id uuid,
  child_archived_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_ri record;
  v_child public.expected_packages%ROWTYPE;
  v_parent_id uuid;
  v_other_links bigint;
BEGIN
  SELECT ri.id, ri.expected_item_id, ri.deleted_at
    INTO v_ri
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id
    AND ri.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND OR v_ri.expected_item_id IS NULL THEN
    IF p_soft_delete AND FOUND AND v_ri.deleted_at IS NULL THEN
      UPDATE public.return_items SET deleted_at = now() WHERE id = p_return_item_id;
    ELSIF NOT p_soft_delete AND FOUND THEN
      DELETE FROM public.return_items WHERE id = p_return_item_id;
    END IF;
    released := false;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT ep.*
    INTO v_child
  FROM public.expected_packages ep
  WHERE ep.id = v_ri.expected_item_id
  FOR UPDATE;

  v_parent_id := v_child.parent_expected_package_id;

  IF COALESCE(v_child.build_source, '') = 'receive_allocated' AND v_parent_id IS NOT NULL THEN
    UPDATE public.expected_packages
      SET expected_scan_quantity = GREATEST(COALESCE(expected_scan_quantity, 0) - 1, 0),
          updated_at = now()
    WHERE id = v_child.id;

    UPDATE public.expected_packages
      SET expected_scan_quantity = COALESCE(expected_scan_quantity, 0) + 1,
          updated_at = now()
    WHERE id = v_parent_id;

    SELECT count(*) INTO v_other_links
    FROM public.return_items ri
    WHERE ri.expected_item_id = v_child.id
      AND ri.id <> p_return_item_id
      AND ri.deleted_at IS NULL;

    IF GREATEST(COALESCE(v_child.expected_scan_quantity, 0) - 1, 0) = 0 AND v_other_links = 0 THEN
      DELETE FROM public.expected_packages WHERE id = v_child.id;
      child_archived_id := v_child.id;
    END IF;

    parent_restored_id := v_parent_id;
  END IF;

  IF p_soft_delete THEN
    UPDATE public.return_items
      SET deleted_at = now(), expected_item_id = NULL, updated_at = now()
    WHERE id = p_return_item_id;
  ELSE
    UPDATE public.return_items
      SET expected_item_id = NULL, updated_at = now()
    WHERE id = p_return_item_id;
  END IF;

  released := true;
  RETURN NEXT;
END;
$function$;

-- ── move one unit to new scope ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.move_expected_item_unit(
  p_return_item_id uuid,
  p_organization_id uuid,
  p_store_id uuid,
  p_new_package_id uuid,
  p_new_receive_scope_key text,
  p_new_order_id text DEFAULT NULL,
  p_new_tracking_number text DEFAULT NULL,
  p_new_resolved_product_id uuid DEFAULT NULL
)
RETURNS TABLE (
  new_allocated_expected_package_id uuid,
  old_child_archived_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_ri record;
  v_release record;
  v_alloc record;
BEGIN
  SELECT ri.*
    INTO v_ri
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id
    AND ri.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_item_not_found';
  END IF;

  SELECT r.released, r.child_archived_id
    INTO v_release
  FROM public.release_expected_item_unit(p_return_item_id, p_organization_id, false) r;

  old_child_archived_id := v_release.child_archived_id;

  UPDATE public.return_items
    SET package_id = p_new_package_id,
        order_id = COALESCE(p_new_order_id, order_id),
        updated_at = now()
  WHERE id = p_return_item_id;

  SELECT a.allocated_expected_package_id
    INTO new_allocated_expected_package_id
  FROM public.allocate_expected_item_unit(
    p_return_item_id,
    p_organization_id,
    p_store_id,
    p_new_package_id,
    p_new_receive_scope_key,
    COALESCE(p_new_order_id, v_ri.order_id),
    p_new_tracking_number,
    NULL,
    v_ri.sku,
    v_ri.fnsku,
    v_ri.product_identifier,
    v_ri.asin,
    COALESCE(p_new_resolved_product_id, v_ri.resolved_product_id),
    NULL
  ) a;

  RETURN NEXT;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.allocate_expected_item_unit(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.allocate_expected_items_for_return_item_ids(uuid[], uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_expected_item_unit(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.move_expected_item_unit(uuid, uuid, uuid, uuid, text, text, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
