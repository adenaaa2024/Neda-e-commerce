-- NEXT-PRODUCT-ID-04 — Read-only verification: amazon_fba_inventory resolver columns.
-- Run in Supabase SQL editor after migration apply. SELECT only. No writes.

-- 1) Column presence
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'amazon_fba_inventory'
  AND column_name IN (
    'resolved_product_id',
    'resolved_catalog_product_id',
    'identifier_resolution_status',
    'identifier_resolution_confidence'
  )
ORDER BY column_name;

-- 2) Partial index exists (name from migration)
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'amazon_fba_inventory'
  AND indexname = 'idx_amazon_fba_inventory_org_resolved_product';

-- 3) Null fraction (no UPDATE)
SELECT
  count(*) AS total_rows,
  count(*) FILTER (WHERE resolved_product_id IS NULL) AS null_resolved_product_id,
  count(*) FILTER (WHERE resolved_catalog_product_id IS NULL) AS null_resolved_catalog_product_id
FROM public.amazon_fba_inventory;
