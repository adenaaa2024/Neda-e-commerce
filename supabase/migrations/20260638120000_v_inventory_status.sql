-- Operator Identification Gate: one row per expected_packages line with scan totals
-- and catalog identifiers for multi-field scan matching (tracking, SKU, FNSKU, UPC, ASIN).

BEGIN;

CREATE OR REPLACE VIEW public.v_inventory_status AS
SELECT
  ep.id AS expected_package_id,
  ep.organization_id,
  ep.store_id,
  ep.tracking_number,
  ep.sku,
  ep.fnsku,
  NULLIF(trim(COALESCE(p.asin, '')::text), '')::text AS asin,
  COALESCE(NULLIF(trim(COALESCE(p.upc_code, '')::text), ''), '')::text AS upc,
  COALESCE(ep.expected_scan_quantity, 0)::bigint AS total_expected,
  COALESCE(ep.actual_scanned_count, 0)::bigint AS total_scanned
FROM public.expected_packages ep
LEFT JOIN public.products p
  ON p.organization_id = ep.organization_id
 AND p.store_id IS NOT DISTINCT FROM ep.store_id
 AND lower(btrim(p.sku)) = lower(btrim(ep.sku));

COMMENT ON VIEW public.v_inventory_status IS
  'Per expected_packages line: expected vs actual scan counts plus identifiers for '
  'operator gate lookup (tracking_number ILIKE + exact sku/fnsku/asin/upc from products join).';

GRANT SELECT ON public.v_inventory_status TO authenticated;
GRANT SELECT ON public.v_inventory_status TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
