-- INVENTORY-VIEWS-MIGRATION-SNAPSHOT-V180
-- Snapshot of staging inventory views (ref eiqfaapyumhixxoeltgu, 2026-05).
-- CREATE OR REPLACE VIEW only — no package_items, no legacy returns table.
-- Product linkage for Neda remains read-time via fetchInventoryItemStatusForNeda
-- until return_items resolver backfill is approved (see optional block at file end).

-- 1) Scanned line aggregates (depends: return_items, packages, pallets)
CREATE OR REPLACE VIEW public.v_scanned_items_counted AS
WITH scanned_grouped AS (
  SELECT
    r.organization_id,
    r.store_id,
    TRIM(BOTH ' []"'::text FROM split_part(COALESCE(p.tracking_number, pl.tracking_number), ','::text, 1)) AS tracking_number,
    p.id_slip_contents AS slip_code,
    r.sku,
    r.fnsku,
    r.asin,
    TRIM(BOTH ' []"'::text FROM split_part(max(p.carrier_name), ','::text, 1)) AS carrier,
    max(COALESCE(p.created_at, r.created_at)) AS package_date,
    max(pl.order_id) AS order_id,
    count(*) AS total_scanned
  FROM public.return_items r
  LEFT JOIN public.packages p ON r.package_id = p.id
  LEFT JOIN public.pallets pl ON COALESCE(r.pallet_id, p.pallet_id) = pl.id
  GROUP BY
    r.organization_id,
    r.store_id,
    (TRIM(BOTH ' []"'::text FROM split_part(COALESCE(p.tracking_number, pl.tracking_number), ','::text, 1))),
    p.id_slip_contents,
    r.sku,
    r.fnsku,
    r.asin
),
with_package_count AS (
  SELECT
    scanned_grouped.organization_id,
    scanned_grouped.store_id,
    scanned_grouped.tracking_number,
    scanned_grouped.slip_code,
    scanned_grouped.sku,
    scanned_grouped.fnsku,
    scanned_grouped.asin,
    scanned_grouped.carrier,
    scanned_grouped.package_date,
    scanned_grouped.order_id,
    scanned_grouped.total_scanned,
    CASE
      WHEN NULLIF(TRIM(BOTH FROM COALESCE(scanned_grouped.slip_code, ''::text)), ''::text) IS NULL THEN 0::bigint
      ELSE count(*) OVER (
        PARTITION BY
          scanned_grouped.organization_id,
          scanned_grouped.store_id,
          scanned_grouped.tracking_number,
          scanned_grouped.slip_code
      )
    END AS package_count
  FROM scanned_grouped
)
SELECT
  organization_id,
  store_id,
  tracking_number,
  slip_code,
  sku,
  fnsku,
  asin,
  carrier,
  package_date,
  order_id,
  total_scanned,
  package_count
FROM with_package_count;

-- 2) Item-level expected vs scanned (depends: expected_packages, v_scanned_items_counted)
CREATE OR REPLACE VIEW public.v_inventory_item_status AS
WITH expected_totals AS (
  SELECT
    ep.organization_id,
    ep.store_id,
    TRIM(BOTH ' []"'::text FROM split_part(ep.tracking_number, ','::text, 1)) AS tracking_number,
    ep.id_slip_contents AS slip_code,
    ep.sku,
    ep.fnsku,
    NULL::text AS asin,
    NULL::text AS upc,
    NULL::text AS product_name,
    TRIM(BOTH ' []"'::text FROM split_part(max(ep.carrier), ','::text, 1)) AS carrier,
    max(COALESCE(ep.shipment_date::timestamptz, ep.created_at)) AS package_date,
    max(ep.order_id) AS order_id,
    sum(ep.expected_scan_quantity)::numeric AS total_expected,
    0::numeric AS total_scanned
  FROM public.expected_packages ep
  GROUP BY
    ep.organization_id,
    ep.store_id,
    (TRIM(BOTH ' []"'::text FROM split_part(ep.tracking_number, ','::text, 1))),
    ep.id_slip_contents,
    ep.sku,
    ep.fnsku
),
scanned_totals AS (
  SELECT
    s.organization_id,
    s.store_id,
    s.tracking_number,
    s.slip_code,
    s.sku,
    s.fnsku,
    s.asin,
    NULL::text AS upc,
    NULL::text AS product_name,
    s.carrier,
    s.package_date,
    s.order_id,
    0::numeric AS total_expected,
    s.total_scanned::numeric AS total_scanned
  FROM public.v_scanned_items_counted s
),
combined_totals AS (
  SELECT * FROM expected_totals
  UNION ALL
  SELECT * FROM scanned_totals
),
item_grouped AS (
  SELECT
    combined_totals.organization_id,
    combined_totals.store_id,
    combined_totals.tracking_number,
    combined_totals.slip_code,
    max(combined_totals.order_id) AS order_id,
    combined_totals.sku,
    combined_totals.fnsku,
    max(combined_totals.asin) AS asin,
    max(combined_totals.upc) AS upc,
    max(combined_totals.product_name) AS product_name,
    max(combined_totals.carrier) AS carrier,
    max(combined_totals.package_date) AS package_date,
    sum(combined_totals.total_expected) AS total_expected,
    sum(combined_totals.total_scanned) AS total_scanned,
    CASE
      WHEN sum(combined_totals.total_expected) = 0::numeric AND sum(combined_totals.total_scanned) = 0::numeric THEN 'not_registered'::text
      WHEN sum(combined_totals.total_expected) = 0::numeric AND sum(combined_totals.total_scanned) > 0::numeric THEN 'in_progress_not'::text
      WHEN sum(combined_totals.total_expected) > 0::numeric AND sum(combined_totals.total_scanned) = 0::numeric THEN 'expected'::text
      WHEN sum(combined_totals.total_expected) > 0::numeric AND sum(combined_totals.total_scanned) < sum(combined_totals.total_expected) THEN 'in_progress'::text
      WHEN sum(combined_totals.total_expected) > 0::numeric AND sum(combined_totals.total_scanned) = sum(combined_totals.total_expected) THEN 'complete'::text
      WHEN sum(combined_totals.total_expected) > 0::numeric AND sum(combined_totals.total_scanned) > sum(combined_totals.total_expected) THEN 'unexpected'::text
      ELSE 'not_registered'::text
    END AS status
  FROM combined_totals
  GROUP BY
    combined_totals.organization_id,
    combined_totals.store_id,
    combined_totals.tracking_number,
    combined_totals.slip_code,
    combined_totals.sku,
    combined_totals.fnsku
),
with_package_count AS (
  SELECT
    item_grouped.*,
    CASE
      WHEN NULLIF(TRIM(BOTH FROM COALESCE(item_grouped.slip_code, ''::text)), ''::text) IS NULL THEN 0::bigint
      ELSE count(*) OVER (
        PARTITION BY
          item_grouped.organization_id,
          item_grouped.store_id,
          item_grouped.tracking_number,
          item_grouped.slip_code
      )
    END AS package_count
  FROM item_grouped
)
SELECT
  organization_id,
  store_id,
  tracking_number,
  slip_code,
  order_id,
  sku,
  fnsku,
  asin,
  upc,
  product_name,
  carrier,
  package_date,
  total_expected,
  total_scanned,
  status,
  package_count
FROM with_package_count;

-- 3) Package-level rollup (depends: v_inventory_item_status)
CREATE OR REPLACE VIEW public.v_inventory_status AS
SELECT
  organization_id,
  store_id,
  tracking_number,
  slip_code,
  max(order_id) AS order_id,
  max(package_date) AS package_date,
  max(carrier) AS carrier,
  sum(total_expected) AS total_expected,
  sum(total_scanned) AS total_scanned,
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
  'Neda inventory: scanned return_items grouped by tracking/slip/SKU (V180 snapshot).';
COMMENT ON VIEW public.v_inventory_item_status IS
  'Neda inventory: expected_packages ∪ scanned totals per line (V180 snapshot). Product linkage via server read path.';
COMMENT ON VIEW public.v_inventory_status IS
  'Neda inventory: package-level status chip inputs only — no product linkage (V180 snapshot).';

-- ---------------------------------------------------------------------------
-- OPTIONAL (not applied): extend v_inventory_item_status with resolver + products
-- Gate: .cursor/operator-approvals/return-items-resolver-backfill-v180-approval.md
--       APPROVED_TO_RUN_STAGING=true (and production approval if ever needed).
--
-- After return_items.resolved_product_id backfill, add CTE scanned_resolver AS (
--   SELECT
--     r.organization_id,
--     r.store_id,
--     TRIM(BOTH ' []"' FROM split_part(COALESCE(p.tracking_number, pl.tracking_number), ',')) AS tracking_number,
--     p.id_slip_contents AS slip_code,
--     r.sku,
--     r.fnsku,
--     max(r.resolved_product_id) AS resolved_product_id
--   FROM public.return_items r
--   LEFT JOIN public.packages p ON r.package_id = p.id
--   LEFT JOIN public.pallets pl ON COALESCE(r.pallet_id, p.pallet_id) = pl.id
--   WHERE r.deleted_at IS NULL
--   GROUP BY 1, 2, 3, 4, 5, 6
-- )
-- and in final SELECT add:
--   sr.resolved_product_id,
--   p.product_name AS resolved_product_name
-- LEFT JOIN scanned_resolver sr ON ...matching keys...
-- LEFT JOIN public.products p ON p.id = sr.resolved_product_id AND p.organization_id = sr.organization_id;
-- Re-run CREATE OR REPLACE for v_inventory_item_status then v_inventory_status.
-- ---------------------------------------------------------------------------
