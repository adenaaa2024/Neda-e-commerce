-- SCANNER-QUANTITY-BATCH-BACKEND-PREP (Phase 2 — allocation RPCs)
-- Apply on staging after Phase 1 verify. Replaces +1/-1 unit steps with scanned_quantity from return_items.

BEGIN;

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
  v_qty               integer;
BEGIN
  SELECT ri.expected_item_id, ri.resolved_product_id, GREATEST(COALESCE(ri.scanned_quantity, 1), 1)
    INTO v_existing_ep, v_scanned_product, v_qty
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id
    AND ri.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_item_not_found';
  END IF;

  IF v_existing_ep IS NOT NULL THEN
    SELECT ep.parent_expected_package_id INTO parent_expected_package_id
    FROM public.expected_packages ep WHERE ep.id = v_existing_ep;
    allocated_expected_package_id := v_existing_ep;
    product_match_status := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  v_norm_tracking := public._normalize_tracking_token(p_tracking_number);

  IF p_expected_package_hint IS NOT NULL THEN
    SELECT ep.* INTO v_parent
    FROM public.expected_packages ep
    WHERE ep.id = p_expected_package_hint
      AND ep.organization_id = p_organization_id
      AND ep.store_id = p_store_id
      AND ep.parent_expected_package_id IS NULL
      AND COALESCE(ep.expected_scan_quantity, 0) >= v_qty
    FOR UPDATE;
  END IF;

  IF v_parent.id IS NULL THEN
    SELECT ep.* INTO v_parent
    FROM public.expected_packages ep
    WHERE ep.organization_id = p_organization_id
      AND ep.store_id = p_store_id
      AND ep.parent_expected_package_id IS NULL
      AND COALESCE(ep.build_source, 'legacy') <> 'receive_allocated'
      AND COALESCE(ep.expected_scan_quantity, 0) >= v_qty
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

  IF v_parent.id IS NULL OR COALESCE(v_parent.expected_scan_quantity, 0) < v_qty THEN
    RAISE EXCEPTION 'no_allocatable_expected';
  END IF;

  IF p_package_id IS NOT NULL THEN
    SELECT p.id_slip_contents, p.pallet_id INTO v_slip, v_pallet_id
    FROM public.packages p
    WHERE p.id = p_package_id AND p.organization_id = p_organization_id;
  END IF;

  SELECT ep.id INTO v_child_id
  FROM public.expected_packages ep
  WHERE ep.parent_expected_package_id = v_parent.id
    AND ep.build_source = 'receive_allocated'
    AND ep.receive_scope_key IS NOT DISTINCT FROM p_receive_scope_key
  FOR UPDATE;

  IF v_child_id IS NOT NULL THEN
    UPDATE public.expected_packages
      SET expected_scan_quantity = COALESCE(expected_scan_quantity, 0) + v_qty,
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
      v_qty, 'receive_allocated', 'matched', v_parent.detail_grouping_key,
      v_parent.id, p_receive_scope_key,
      p_package_id, v_pallet_id, v_slip,
      v_parent.resolved_product_id
    )
    RETURNING id INTO v_child_id;
  END IF;

  UPDATE public.expected_packages
    SET expected_scan_quantity = GREATEST(COALESCE(expected_scan_quantity, 0) - v_qty, 0),
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

COMMENT ON FUNCTION public.allocate_expected_item_unit(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid
) IS
  'Allocate expected_packages remainder by return_items.scanned_quantity (not always 1).';

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
  v_qty integer;
BEGIN
  SELECT ri.id, ri.expected_item_id, ri.deleted_at, GREATEST(COALESCE(ri.scanned_quantity, 1), 1)
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

  v_qty := GREATEST(COALESCE(v_ri.scanned_quantity, 1), 1);

  SELECT ep.*
    INTO v_child
  FROM public.expected_packages ep
  WHERE ep.id = v_ri.expected_item_id
  FOR UPDATE;

  v_parent_id := v_child.parent_expected_package_id;

  IF COALESCE(v_child.build_source, '') = 'receive_allocated' AND v_parent_id IS NOT NULL THEN
    UPDATE public.expected_packages
      SET expected_scan_quantity = GREATEST(COALESCE(expected_scan_quantity, 0) - v_qty, 0),
          updated_at = now()
    WHERE id = v_child.id;

    UPDATE public.expected_packages
      SET expected_scan_quantity = COALESCE(expected_scan_quantity, 0) + v_qty,
          updated_at = now()
    WHERE id = v_parent_id;

    SELECT count(*) INTO v_other_links
    FROM public.return_items ri
    WHERE ri.expected_item_id = v_child.id
      AND ri.id <> p_return_item_id
      AND ri.deleted_at IS NULL;

    IF GREATEST(COALESCE(v_child.expected_scan_quantity, 0) - v_qty, 0) = 0 AND v_other_links = 0 THEN
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

COMMENT ON FUNCTION public.release_expected_item_unit(uuid, uuid, boolean) IS
  'Release expected_packages remainder by return_items.scanned_quantity (not always 1). move_expected_item_unit inherits via release+allocate.';

NOTIFY pgrst, 'reload schema';

COMMIT;
