-- INVENTORY-VIEWS-RETURN-ITEMS-DELETED-AT-FILTER-V189
-- Exclude soft-deleted return_items from Neda scanned aggregates (aligns with returns UI / FBM KPI filters).
-- Depends on V180 view definitions; replaces v_scanned_items_counted only (downstream views read this CTE source).

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
  WHERE r.deleted_at IS NULL
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

COMMENT ON VIEW public.v_scanned_items_counted IS
  'Neda inventory: scanned return_items grouped by tracking/slip/SKU (V189: excludes deleted_at IS NOT NULL).';
