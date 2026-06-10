-- Phase 9F — product search indexes (Add Scan Item / scanner product resolution)
-- No new tables/columns. Does not enable pg_trgm (extension must already exist for title index).

BEGIN;

CREATE INDEX IF NOT EXISTS idx_products_org_store_fnsku
  ON public.products (organization_id, store_id, fnsku)
  WHERE fnsku IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_org_store_asin
  ON public.products (organization_id, store_id, asin)
  WHERE asin IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_org_store_upc_code
  ON public.products (organization_id, store_id, upc_code)
  WHERE upc_code IS NOT NULL;

-- idx_products_org_store_sku — created in 20260630130000_product_identity_existing_tables.sql

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS idx_products_org_store_product_name_trgm
        ON public.products USING gin (product_name gin_trgm_ops)
        WHERE product_name IS NOT NULL AND btrim(product_name) <> ''
    $idx$;
  END IF;
END $$;

COMMENT ON INDEX public.idx_products_org_store_fnsku IS
  'Phase 9F: exact products.fnsku lookup (org+store) for scanner product search fallback.';

COMMENT ON INDEX public.idx_products_org_store_asin IS
  'Phase 9F: exact products.asin lookup (org+store) for scanner product search fallback.';

COMMENT ON INDEX public.idx_products_org_store_upc_code IS
  'Phase 9F: exact products.upc_code lookup (org+store) for scanner product search fallback.';

COMMIT;

NOTIFY pgrst, 'reload schema';
