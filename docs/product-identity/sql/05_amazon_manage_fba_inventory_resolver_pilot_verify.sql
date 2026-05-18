-- NEXT-UNIVERSAL-RESOLVER-09 — Upload-scoped pilot verification for amazon_manage_fba_inventory
-- Read-only. Replace upload UUID literals below.

-- 1) Row counts for the upload
SELECT count(*) AS rows_total
FROM public.amazon_manage_fba_inventory
WHERE source_upload_id = '00000000-0000-0000-0000-000000000000'::uuid;

-- 2) Identifier fill rates (typed columns)
SELECT
  count(*) FILTER (WHERE nullif(trim(sku), '') IS NOT NULL) AS sku_present,
  count(*) FILTER (WHERE nullif(trim(asin), '') IS NOT NULL) AS asin_present,
  count(*) FILTER (WHERE nullif(trim(fnsku), '') IS NOT NULL) AS fnsku_present
FROM public.amazon_manage_fba_inventory
WHERE source_upload_id = '00000000-0000-0000-0000-000000000000'::uuid;

-- 3) Resolution status distribution (Convention A quad)
SELECT coalesce(identifier_resolution_status, '(null)') AS status, count(*) AS n
FROM public.amazon_manage_fba_inventory
WHERE source_upload_id = '00000000-0000-0000-0000-000000000000'::uuid
GROUP BY 1
ORDER BY n DESC;

-- 4) Ambiguity / unresolved ratios (pre-run baseline)
SELECT
  count(*) AS scanned,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL) AS resolved,
  count(*) FILTER (WHERE identifier_resolution_status = 'ambiguous') AS ambiguous,
  count(*) FILTER (WHERE identifier_resolution_status = 'unresolved' OR identifier_resolution_status IS NULL) AS unresolved_or_null
FROM public.amazon_manage_fba_inventory
WHERE source_upload_id = '00000000-0000-0000-0000-000000000000'::uuid;
