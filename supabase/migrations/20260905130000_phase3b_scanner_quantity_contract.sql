-- PHASE-3B-SCANNER-QUANTITY-BACKEND-CONTRACT-FIX
-- SUM(scanned_quantity) in inventory views; quantity-aware package counters; preserve 20260904 orphan-RI columns.

BEGIN;

-- ── 1) packages.actual_item_count uses scanned_quantity ───────────────────────
CREATE OR REPLACE FUNCTION public.sync_package_item_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_qty integer;
  v_old_qty integer;
BEGIN
  v_new_qty := GREATEST(COALESCE(NEW.scanned_quantity, 1), 1);
  v_old_qty := GREATEST(COALESCE(OLD.scanned_quantity, 1), 1);

  IF TG_OP = 'INSERT' AND NEW.package_id IS NOT NULL THEN
    UPDATE public.packages
       SET actual_item_count = COALESCE(actual_item_count, 0) + v_new_qty
     WHERE id = NEW.package_id;

  ELSIF TG_OP = 'DELETE' AND OLD.package_id IS NOT NULL THEN
    UPDATE public.packages
       SET actual_item_count = GREATEST(COALESCE(actual_item_count, 0) - v_old_qty, 0)
     WHERE id = OLD.package_id;

  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.package_id IS NOT DISTINCT FROM NEW.package_id
       AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at
       AND v_old_qty = v_new_qty THEN
      RETURN NEW;
    END IF;

    IF OLD.package_id IS NOT NULL
       AND (OLD.package_id IS DISTINCT FROM NEW.package_id OR OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN
      UPDATE public.packages
         SET actual_item_count = GREATEST(COALESCE(actual_item_count, 0) - v_old_qty, 0)
       WHERE id = OLD.package_id;
    END IF;

    IF NEW.package_id IS NOT NULL AND NEW.deleted_at IS NULL
       AND (OLD.package_id IS DISTINCT FROM NEW.package_id OR OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL) THEN
      UPDATE public.packages
         SET actual_item_count = COALESCE(actual_item_count, 0) + v_new_qty
       WHERE id = NEW.package_id;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.sync_package_item_count() IS
  'Keeps packages.actual_item_count aligned with SUM(return_items.scanned_quantity) per package.';

DROP TRIGGER IF EXISTS trg_sync_package_item_count ON public.return_items;
CREATE TRIGGER trg_sync_package_item_count
  AFTER INSERT OR UPDATE OR DELETE ON public.return_items
  FOR EACH ROW EXECUTE FUNCTION public.sync_package_item_count();

-- ── 2) void/delete RPC — rely on trg_sync_package_item_count (no manual +/-1) ─
CREATE OR REPLACE FUNCTION public.delete_return_item_with_expected_release(
  p_organization_id uuid,
  p_return_item_id  uuid,
  p_actor_id        uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_reason          text DEFAULT NULL,
  p_undo_batch_id   uuid DEFAULT NULL
)
RETURNS TABLE (ok boolean, undo_batch_id uuid, message text)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_ri public.return_items%ROWTYPE;
  v_batch uuid;
  v_released boolean;
  v_parent uuid;
  v_child uuid;
  v_alloc_snap jsonb;
  v_claim_count integer;
BEGIN
  IF NOT public._ops_require_permission(p_actor_id, 'ops.delete_return_item') THEN
    RETURN QUERY SELECT false, NULL::uuid, 'permission_denied';
    RETURN;
  END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.audit_events ae
    WHERE ae.organization_id = p_organization_id AND ae.idempotency_key = p_idempotency_key
  ) THEN
    SELECT ae.undo_batch_id INTO v_batch
    FROM public.audit_events ae
    WHERE ae.organization_id = p_organization_id AND ae.idempotency_key = p_idempotency_key
    LIMIT 1;
    RETURN QUERY SELECT true, v_batch, 'idempotent_replay';
    RETURN;
  END IF;

  SELECT * INTO v_ri
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id AND ri.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, 'return_item_not_found';
    RETURN;
  END IF;

  IF v_ri.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT true, v_ri.undo_batch_id, 'already_deleted';
    RETURN;
  END IF;

  v_claim_count := public._ops_active_claims_for_return_item(p_organization_id, p_return_item_id);
  IF v_claim_count > 0 THEN
    RETURN QUERY SELECT false, NULL::uuid, 'active_claim_submission';
    RETURN;
  END IF;

  v_batch := COALESCE(p_undo_batch_id, public._ops_undo_batch_start(p_organization_id, p_actor_id, p_reason));

  IF v_ri.expected_item_id IS NOT NULL THEN
    v_alloc_snap := public._ops_expected_allocation_snapshot(v_ri.expected_item_id);
  END IF;

  PERFORM public._ops_undo_capture(
    p_organization_id, v_batch, 'return_item', v_ri.id,
    to_jsonb(v_ri),
    jsonb_build_object('package_id', v_ri.package_id, 'pallet_id', v_ri.pallet_id),
    v_alloc_snap
  );

  IF v_ri.expected_item_id IS NOT NULL THEN
    SELECT r.released, r.parent_restored_id, r.child_archived_id
    INTO v_released, v_parent, v_child
    FROM public.release_expected_item_unit(p_return_item_id, p_organization_id, false) r;

    PERFORM public._ops_log_audit_event(
      p_organization_id, 'return_item', v_ri.id, 'expected_release', p_actor_id, v_batch,
      NULL, jsonb_build_object('released', v_released, 'parent_restored_id', v_parent, 'child_archived_id', v_child)
    );
  END IF;

  UPDATE public.return_items
  SET deleted_at = now(),
      deleted_by = p_actor_id,
      undo_batch_id = v_batch,
      updated_at = now()
  WHERE id = p_return_item_id;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'return_item', v_ri.id, 'delete_return_item', p_actor_id, v_batch,
    to_jsonb(v_ri), NULL, jsonb_build_object('reason', p_reason, 'idempotency_key', p_idempotency_key)
  );

  RETURN QUERY SELECT true, v_batch, 'deleted';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.move_return_item_parent(
  p_organization_id       uuid,
  p_return_item_id        uuid,
  p_package_id            uuid DEFAULT NULL,
  p_pallet_id             uuid DEFAULT NULL,
  p_store_id              uuid DEFAULT NULL,
  p_new_receive_scope_key text DEFAULT NULL,
  p_new_tracking_number   text DEFAULT NULL,
  p_actor_id              uuid DEFAULT NULL,
  p_reason                text DEFAULT NULL
)
RETURNS TABLE (ok boolean, undo_batch_id uuid, message text)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_ri public.return_items%ROWTYPE;
  v_batch uuid;
  v_before jsonb;
  v_new_ep uuid;
  v_old_child uuid;
BEGIN
  IF NOT public._ops_require_permission(p_actor_id, 'ops.move_return_item_parent') THEN
    RETURN QUERY SELECT false, NULL::uuid, 'permission_denied';
    RETURN;
  END IF;

  SELECT * INTO v_ri
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id AND ri.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND OR v_ri.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, 'return_item_not_found_or_deleted';
    RETURN;
  END IF;

  v_batch := public._ops_undo_batch_start(p_organization_id, p_actor_id, COALESCE(p_reason, 'move_parent'));
  v_before := to_jsonb(v_ri);

  PERFORM public._ops_undo_capture(
    p_organization_id, v_batch, 'return_item', v_ri.id, v_before,
    jsonb_build_object('package_id', v_ri.package_id, 'pallet_id', v_ri.pallet_id),
    public._ops_expected_allocation_snapshot(v_ri.expected_item_id)
  );

  UPDATE public.return_items
  SET package_id = COALESCE(p_package_id, package_id),
      pallet_id = COALESCE(p_pallet_id, pallet_id),
      updated_at = now()
  WHERE id = p_return_item_id
  RETURNING * INTO v_ri;

  IF v_ri.expected_item_id IS NOT NULL
     AND p_store_id IS NOT NULL
     AND p_new_receive_scope_key IS NOT NULL
     AND trim(p_new_receive_scope_key) <> '' THEN
    SELECT m.new_allocated_expected_package_id, m.old_child_archived_id
    INTO v_new_ep, v_old_child
    FROM public.move_expected_item_unit(
      p_return_item_id,
      p_organization_id,
      p_store_id,
      COALESCE(p_package_id, v_ri.package_id),
      trim(p_new_receive_scope_key),
      v_ri.order_id,
      p_new_tracking_number,
      v_ri.resolved_product_id
    ) m;

    PERFORM public._ops_log_audit_event(
      p_organization_id, 'return_item', v_ri.id, 'expected_move', p_actor_id, v_batch,
      NULL, jsonb_build_object('new_allocated_ep', v_new_ep, 'old_child_archived_id', v_old_child)
    );
  END IF;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'return_item', v_ri.id, 'move_parent', p_actor_id, v_batch,
    v_before, to_jsonb(v_ri), jsonb_build_object('package_id', p_package_id, 'pallet_id', p_pallet_id)
  );

  RETURN QUERY SELECT true, v_batch, 'moved';
END;
$fn$;

-- ── 3) Inventory views — SUM(scanned_quantity) + scan_batch_count (20260904 parity) ─
DROP VIEW IF EXISTS public.v_inventory_status CASCADE;
DROP VIEW IF EXISTS public.v_inventory_item_status CASCADE;
DROP VIEW IF EXISTS public.v_scanned_items_counted CASCADE;

CREATE VIEW public.v_scanned_items_counted AS
WITH scanned_grouped AS (
         SELECT r.organization_id,
            r.store_id,
            tn.operational AS tracking_number,
            p.id_slip_contents AS slip_code,
            max(p.package_code) AS package_code,
            r.sku,
            r.fnsku,
            r.asin,
            NULLIF(btrim(max(r.product_identifier)), ''::text) AS upc,
            car.operational AS carrier,
            max(COALESCE(p.created_at, r.created_at)) AS package_date,
            max(pl.order_id) AS order_id,
            sum(COALESCE(r.scanned_quantity, 1))::bigint AS total_scanned,
            count(*)::bigint AS scan_batch_count,
                CASE
                    WHEN count(DISTINCT r.resolved_product_id) FILTER (WHERE r.resolved_product_id IS NOT NULL) > 1 THEN NULL::uuid
                    ELSE max(r.resolved_product_id::text)::uuid
                END AS resolved_product_id,
                CASE
                    WHEN count(DISTINCT r.resolved_catalog_product_id) FILTER (WHERE r.resolved_catalog_product_id IS NOT NULL) > 1 THEN NULL::uuid
                    ELSE max(r.resolved_catalog_product_id::text)::uuid
                END AS resolved_catalog_product_id,
                CASE
                    WHEN count(DISTINCT r.resolved_product_id) FILTER (WHERE r.resolved_product_id IS NOT NULL) > 1 THEN 'ambiguous'::text
                    ELSE max(r.identifier_resolution_status)
                END AS identifier_resolution_status,
            max(r.identifier_resolution_confidence) AS identifier_resolution_confidence
           FROM public.return_items r
             INNER JOIN public.packages p ON r.package_id = p.id
             LEFT JOIN public.pallets pl ON COALESCE(r.pallet_id, p.pallet_id) = pl.id
             LEFT JOIN LATERAL normalize_removal_tracking_operational(COALESCE(p.tracking_number, pl.tracking_number)) tn(operational, status, token_count) ON true
             LEFT JOIN LATERAL normalize_removal_carrier_operational(p.carrier_name) car(operational, status, token_count) ON true
          WHERE r.deleted_at IS NULL AND r.package_id IS NOT NULL
          GROUP BY r.organization_id, r.store_id, tn.operational, p.id_slip_contents, r.sku, r.fnsku, r.asin, car.operational
        ), with_package_count AS (
         SELECT sg.organization_id,
            sg.store_id,
            sg.tracking_number,
            sg.slip_code,
            sg.package_code,
            sg.sku,
            sg.fnsku,
            sg.asin,
            sg.upc,
            sg.carrier,
            sg.package_date,
            sg.order_id,
            sg.total_scanned,
            sg.scan_batch_count,
            sg.resolved_product_id,
            sg.resolved_catalog_product_id,
            sg.identifier_resolution_status,
            sg.identifier_resolution_confidence,
                CASE
                    WHEN NULLIF(btrim(COALESCE(sg.slip_code, ''::text)), ''::text) IS NULL THEN 0::bigint
                    ELSE count(*) OVER (PARTITION BY sg.organization_id, sg.store_id, sg.tracking_number, sg.slip_code)
                END AS package_count
           FROM scanned_grouped sg
        )
 SELECT organization_id,
    store_id,
    tracking_number,
    slip_code,
    slip_code AS id_slip_contents,
    package_code,
    sku,
    fnsku,
    asin,
    upc,
    carrier,
    package_date,
    order_id,
    total_scanned,
    scan_batch_count,
    package_count,
    resolved_product_id,
    resolved_product_id AS product_id,
    resolved_catalog_product_id,
    identifier_resolution_status,
    identifier_resolution_status AS product_linkage_status,
    identifier_resolution_confidence,
    NULL::text AS product_name
   FROM with_package_count;

CREATE VIEW public.v_inventory_item_status AS
WITH expected_totals AS (
         SELECT ep.organization_id,
            ep.store_id,
            tn.operational AS tracking_number,
            ep.id_slip_contents AS slip_code,
            NULL::text AS package_code,
            ep.sku,
            ep.fnsku,
            NULL::text AS asin,
            NULL::text AS upc,
            car.operational AS carrier,
            max(COALESCE(ep.shipment_date::timestamp with time zone, ep.created_at)) AS package_date,
            max(ep.order_id) AS order_id,
            sum(ep.expected_scan_quantity)::numeric AS total_expected,
            0::numeric AS total_scanned,
                CASE
                    WHEN count(DISTINCT ep.resolved_product_id) FILTER (WHERE ep.resolved_product_id IS NOT NULL) > 1 THEN NULL::uuid
                    ELSE max(ep.resolved_product_id::text)::uuid
                END AS resolved_product_id,
                CASE
                    WHEN count(DISTINCT ep.resolved_catalog_product_id) FILTER (WHERE ep.resolved_catalog_product_id IS NOT NULL) > 1 THEN NULL::uuid
                    ELSE max(ep.resolved_catalog_product_id::text)::uuid
                END AS resolved_catalog_product_id,
                CASE
                    WHEN count(DISTINCT ep.resolved_product_id) FILTER (WHERE ep.resolved_product_id IS NOT NULL) > 1 THEN 'ambiguous'::text
                    ELSE max(ep.identifier_resolution_status)
                END AS identifier_resolution_status,
            max(ep.identifier_resolution_confidence) AS identifier_resolution_confidence,
                CASE
                    WHEN count(DISTINCT ep.id) > 1 THEN NULL::uuid
                    ELSE max(ep.id::text)::uuid
                END AS expected_package_id
           FROM public.expected_packages ep
             LEFT JOIN LATERAL normalize_removal_tracking_operational(ep.tracking_number) tn(operational, status, token_count) ON true
             LEFT JOIN LATERAL normalize_removal_carrier_operational(ep.carrier) car(operational, status, token_count) ON true
          GROUP BY ep.organization_id, ep.store_id, tn.operational, ep.id_slip_contents, ep.sku, ep.fnsku, car.operational
        ), scanned_totals AS (
         SELECT s.organization_id,
            s.store_id,
            s.tracking_number,
            s.slip_code,
            s.package_code,
            s.sku,
            s.fnsku,
            s.asin,
            s.upc,
            s.carrier,
            s.package_date,
            s.order_id,
            0::numeric AS total_expected,
            s.total_scanned::numeric AS total_scanned,
            s.resolved_product_id,
            s.resolved_catalog_product_id,
            s.identifier_resolution_status,
            s.identifier_resolution_confidence,
            NULL::uuid AS expected_package_id
           FROM public.v_scanned_items_counted s
        ), combined_totals AS (
         SELECT expected_totals.organization_id,
            expected_totals.store_id,
            expected_totals.tracking_number,
            expected_totals.slip_code,
            expected_totals.package_code,
            expected_totals.sku,
            expected_totals.fnsku,
            expected_totals.asin,
            expected_totals.upc,
            expected_totals.carrier,
            expected_totals.package_date,
            expected_totals.order_id,
            expected_totals.total_expected,
            expected_totals.total_scanned,
            expected_totals.resolved_product_id,
            expected_totals.resolved_catalog_product_id,
            expected_totals.identifier_resolution_status,
            expected_totals.identifier_resolution_confidence,
            expected_totals.expected_package_id
           FROM expected_totals
        UNION ALL
         SELECT scanned_totals.organization_id,
            scanned_totals.store_id,
            scanned_totals.tracking_number,
            scanned_totals.slip_code,
            scanned_totals.package_code,
            scanned_totals.sku,
            scanned_totals.fnsku,
            scanned_totals.asin,
            scanned_totals.upc,
            scanned_totals.carrier,
            scanned_totals.package_date,
            scanned_totals.order_id,
            scanned_totals.total_expected,
            scanned_totals.total_scanned,
            scanned_totals.resolved_product_id,
            scanned_totals.resolved_catalog_product_id,
            scanned_totals.identifier_resolution_status,
            scanned_totals.identifier_resolution_confidence,
            scanned_totals.expected_package_id
           FROM scanned_totals
        ), item_grouped AS (
         SELECT ct.organization_id,
            ct.store_id,
            ct.tracking_number,
            ct.slip_code,
            max(ct.package_code) AS package_code,
            max(ct.order_id) AS order_id,
            ct.sku,
            ct.fnsku,
            max(ct.asin) AS asin,
            max(ct.upc) AS upc,
            max(ct.carrier) AS carrier,
            max(ct.package_date) AS package_date,
            sum(ct.total_expected) AS total_expected,
            sum(ct.total_scanned) AS total_scanned,
                CASE
                    WHEN count(DISTINCT ct.resolved_product_id) FILTER (WHERE ct.resolved_product_id IS NOT NULL) > 1 THEN NULL::uuid
                    ELSE max(ct.resolved_product_id::text)::uuid
                END AS resolved_product_id,
                CASE
                    WHEN count(DISTINCT ct.resolved_catalog_product_id) FILTER (WHERE ct.resolved_catalog_product_id IS NOT NULL) > 1 THEN NULL::uuid
                    ELSE max(ct.resolved_catalog_product_id::text)::uuid
                END AS resolved_catalog_product_id,
                CASE
                    WHEN count(DISTINCT ct.resolved_product_id) FILTER (WHERE ct.resolved_product_id IS NOT NULL) > 1 THEN 'ambiguous'::text
                    WHEN max(ct.resolved_product_id::text) FILTER (WHERE ct.total_expected > 0::numeric) IS NOT NULL AND max(ct.resolved_product_id::text) FILTER (WHERE ct.total_scanned > 0::numeric) IS NOT NULL AND max(ct.resolved_product_id::text) FILTER (WHERE ct.total_expected > 0::numeric) IS DISTINCT FROM max(ct.resolved_product_id::text) FILTER (WHERE ct.total_scanned > 0::numeric) THEN 'mismatch'::text
                    ELSE max(ct.identifier_resolution_status)
                END AS identifier_resolution_status,
            max(ct.identifier_resolution_confidence) AS identifier_resolution_confidence,
                CASE
                    WHEN count(DISTINCT ct.expected_package_id) FILTER (WHERE ct.expected_package_id IS NOT NULL) > 1 THEN NULL::uuid
                    ELSE max(ct.expected_package_id::text)::uuid
                END AS expected_package_id,
                CASE
                    WHEN sum(ct.total_expected) = 0::numeric AND sum(ct.total_scanned) = 0::numeric THEN 'not_registered'::text
                    WHEN sum(ct.total_expected) = 0::numeric AND sum(ct.total_scanned) > 0::numeric THEN 'in_progress_not'::text
                    WHEN sum(ct.total_expected) > 0::numeric AND sum(ct.total_scanned) = 0::numeric THEN 'expected'::text
                    WHEN sum(ct.total_expected) > 0::numeric AND sum(ct.total_scanned) < sum(ct.total_expected) THEN 'in_progress'::text
                    WHEN sum(ct.total_expected) > 0::numeric AND sum(ct.total_scanned) = sum(ct.total_expected) THEN 'complete'::text
                    WHEN sum(ct.total_expected) > 0::numeric AND sum(ct.total_scanned) > sum(ct.total_expected) THEN 'unexpected'::text
                    ELSE 'not_registered'::text
                END AS status
           FROM combined_totals ct
          GROUP BY ct.organization_id, ct.store_id, ct.tracking_number, ct.slip_code, ct.sku, ct.fnsku
        ), with_package_count AS (
         SELECT ig.organization_id,
            ig.store_id,
            ig.tracking_number,
            ig.slip_code,
            ig.package_code,
            ig.order_id,
            ig.sku,
            ig.fnsku,
            ig.asin,
            ig.upc,
            ig.carrier,
            ig.package_date,
            ig.total_expected,
            ig.total_scanned,
            ig.resolved_product_id,
            ig.resolved_catalog_product_id,
            ig.identifier_resolution_status,
            ig.identifier_resolution_confidence,
            ig.expected_package_id,
            ig.status,
                CASE
                    WHEN NULLIF(btrim(COALESCE(ig.slip_code, ''::text)), ''::text) IS NULL THEN 0::bigint
                    ELSE count(*) OVER (PARTITION BY ig.organization_id, ig.store_id, ig.tracking_number, ig.slip_code)
                END AS package_count
           FROM item_grouped ig
        ), with_product_name AS (
         SELECT wpc.organization_id,
            wpc.store_id,
            wpc.tracking_number,
            wpc.slip_code,
            wpc.package_code,
            wpc.order_id,
            wpc.sku,
            wpc.fnsku,
            wpc.asin,
            wpc.upc,
            wpc.carrier,
            wpc.package_date,
            wpc.total_expected,
            wpc.total_scanned,
            wpc.resolved_product_id,
            wpc.resolved_catalog_product_id,
            wpc.identifier_resolution_status,
            wpc.identifier_resolution_confidence,
            wpc.status,
            wpc.package_count,
            wpc.expected_package_id,
                CASE
                    WHEN wpc.resolved_product_id IS NOT NULL THEN pr.product_name
                    ELSE NULL::text
                END AS product_name
           FROM with_package_count wpc
             LEFT JOIN public.products pr ON pr.id = wpc.resolved_product_id AND pr.organization_id = wpc.organization_id AND (pr.store_id IS NULL OR NOT pr.store_id IS DISTINCT FROM wpc.store_id)
        )
 SELECT organization_id,
    store_id,
    tracking_number,
    slip_code,
    slip_code AS id_slip_contents,
    package_code,
    order_id,
    sku,
    fnsku,
    asin,
    upc,
    carrier,
    package_date,
    total_expected,
    total_scanned,
    total_expected AS expected_qty,
    total_scanned AS scanned_qty,
    total_scanned - total_expected AS variance_qty,
    status,
    package_count,
    resolved_product_id,
    resolved_product_id AS product_id,
    resolved_catalog_product_id,
    identifier_resolution_status,
    identifier_resolution_status AS product_linkage_status,
    identifier_resolution_confidence,
    expected_package_id,
    product_name,
        CASE
            WHEN resolved_product_id IS NOT NULL THEN product_name
            ELSE NULL::text
        END AS product_display_name
   FROM with_product_name;

CREATE VIEW public.v_inventory_status AS
SELECT organization_id,
    store_id,
    tracking_number,
    slip_code,
    slip_code AS id_slip_contents,
    max(package_code) AS package_code,
    max(order_id) AS order_id,
    max(package_date) AS package_date,
    max(carrier) AS carrier,
    sum(total_expected) AS total_expected,
    sum(total_scanned) AS total_scanned,
        CASE
            WHEN count(DISTINCT resolved_product_id) FILTER (WHERE resolved_product_id IS NOT NULL) > 1 THEN NULL::uuid
            ELSE max(resolved_product_id::text)::uuid
        END AS resolved_product_id,
        CASE
            WHEN count(DISTINCT resolved_product_id) FILTER (WHERE resolved_product_id IS NOT NULL) > 1 THEN NULL::uuid
            ELSE max(resolved_product_id::text)::uuid
        END AS product_id,
        CASE
            WHEN count(DISTINCT expected_package_id) FILTER (WHERE expected_package_id IS NOT NULL) > 1 THEN NULL::uuid
            ELSE max(expected_package_id::text)::uuid
        END AS expected_package_id,
        CASE
            WHEN max(resolved_product_id::text)::uuid IS NOT NULL THEN max(product_name)
            ELSE NULL::text
        END AS product_name,
        CASE
            WHEN max(resolved_product_id::text)::uuid IS NOT NULL THEN max(product_display_name)
            ELSE NULL::text
        END AS product_display_name,
    max(identifier_resolution_status) AS identifier_resolution_status,
    max(identifier_resolution_status) AS product_linkage_status,
        CASE
            WHEN sum(total_expected) = 0::numeric AND sum(total_scanned) = 0::numeric THEN 'not_registered'::text
            WHEN sum(total_expected) = 0::numeric AND sum(total_scanned) > 0::numeric THEN 'in_progress_not'::text
            WHEN sum(total_expected) > 0::numeric AND sum(total_scanned) = 0::numeric THEN 'expected'::text
            WHEN sum(total_expected) > 0::numeric AND sum(total_scanned) < sum(total_expected) THEN 'in_progress'::text
            WHEN sum(total_expected) > 0::numeric AND sum(total_scanned) = sum(total_expected) THEN 'complete'::text
            WHEN sum(total_expected) > 0::numeric AND sum(total_scanned) > sum(total_expected) THEN 'unexpected'::text
            ELSE 'not_registered'::text
        END AS status
   FROM public.v_inventory_item_status
  GROUP BY organization_id, store_id, tracking_number, slip_code;

COMMENT ON VIEW public.v_scanned_items_counted IS
  'Package-anchored scans: total_scanned = SUM(scanned_quantity); scan_batch_count = COUNT(rows).';
COMMENT ON VIEW public.v_inventory_item_status IS
  'Expected + scanned union; scanned leg quantity-weighted via v_scanned_items_counted.';
COMMENT ON VIEW public.v_inventory_status IS
  'Package-level rollup; quantity-weighted scanned totals.';

NOTIFY pgrst, 'reload schema';

COMMIT;
