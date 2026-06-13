-- PHASE-INVENTORY-STATUS-VIEW-CLEAN-DISPUTED-GATING-V1
-- Split clean vs disputed expected_packages build_status in inventory views.
-- expected_qty / total_expected = clean expected only (claim-ready gate progress).
-- No mutation of expected_packages or ops tables.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_clean_expected_package_build_status(p_build_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_build_status IS NULL OR btrim(p_build_status) = '' THEN false
    WHEN lower(btrim(replace(replace(p_build_status, ' ', '_'), '-', '_'))) IN (
      'matched', 'expected', 'resolved', 'complete'
    ) THEN true
    WHEN lower(btrim(replace(replace(p_build_status, ' ', '_'), '-', '_'))) IN (
      'shipment_overflow_conflict', 'detail_remainder', 'source_conflict',
      'stale_partial_snapshot', 'duplicate_source_conflict'
    ) THEN false
    WHEN lower(btrim(replace(replace(p_build_status, ' ', '_'), '-', '_'))) LIKE '%matched%'
      AND lower(btrim(replace(replace(p_build_status, ' ', '_'), '-', '_'))) NOT LIKE '%conflict%'
      AND lower(btrim(replace(replace(p_build_status, ' ', '_'), '-', '_'))) NOT LIKE '%overflow%' THEN true
    WHEN lower(btrim(replace(replace(p_build_status, ' ', '_'), '-', '_'))) LIKE '%expected%'
      AND lower(btrim(replace(replace(p_build_status, ' ', '_'), '-', '_'))) NOT LIKE '%no_shipment%' THEN true
    ELSE false
  END;
$$;

COMMENT ON FUNCTION public.is_clean_expected_package_build_status(text) IS
  'Mirrors lib/expected-packages-conflict-status.ts — clean build_status rows count toward gate expected qty.';

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
            sum(
              CASE
                WHEN public.is_clean_expected_package_build_status(ep.build_status)
                THEN COALESCE(ep.expected_scan_quantity, 0)
                ELSE 0
              END
            )::numeric AS total_expected,
            sum(
              CASE
                WHEN NOT public.is_clean_expected_package_build_status(ep.build_status)
                THEN COALESCE(ep.expected_scan_quantity, 0)
                ELSE 0
              END
            )::numeric AS disputed_expected_qty,
            NULLIF(
              string_agg(DISTINCT btrim(ep.build_status), ', ' ORDER BY btrim(ep.build_status))
                FILTER (
                  WHERE NOT public.is_clean_expected_package_build_status(ep.build_status)
                    AND COALESCE(ep.expected_scan_quantity, 0) > 0
                    AND btrim(COALESCE(ep.build_status, '')) <> ''
                ),
              ''
            ) AS disputed_statuses,
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
            0::numeric AS disputed_expected_qty,
            NULL::text AS disputed_statuses,
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
            expected_totals.disputed_expected_qty,
            expected_totals.disputed_statuses,
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
            scanned_totals.disputed_expected_qty,
            scanned_totals.disputed_statuses,
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
            sum(ct.disputed_expected_qty) AS disputed_expected_qty,
            NULLIF(
              string_agg(DISTINCT ct.disputed_statuses, ', ')
                FILTER (WHERE ct.disputed_statuses IS NOT NULL AND btrim(ct.disputed_statuses) <> ''),
              ''
            ) AS disputed_statuses,
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
            ig.disputed_expected_qty,
            ig.disputed_statuses,
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
            wpc.disputed_expected_qty,
            wpc.disputed_statuses,
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
    total_expected AS expected_qty_clean,
    disputed_expected_qty,
    (COALESCE(disputed_expected_qty, 0) > 0) AS needs_reconciliation,
    disputed_statuses,
    'expected_packages.build_status_clean_sum'::text AS clean_expected_qty_source,
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
    sum(disputed_expected_qty) AS disputed_expected_qty,
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
  'Expected + scanned union. total_expected/expected_qty = clean build_status sum only; disputed_expected_qty excluded from gate progress.';
COMMENT ON VIEW public.v_inventory_status IS
  'Package-level rollup; clean expected totals only on total_expected.';

GRANT SELECT ON public.v_scanned_items_counted TO authenticated, service_role;
GRANT SELECT ON public.v_inventory_item_status TO authenticated, service_role;
GRANT SELECT ON public.v_inventory_status TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
