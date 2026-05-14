-- =============================================================================
-- 20260813120000 — amazon_fba_inventory resolver columns (NEXT-PRODUCT-ID-04)
--
-- Aligns Inventory Health (`amazon_fba_inventory`) with the resolver column
-- pattern introduced for other Amazon operational tables in
-- 20260642_amazon_import_file_alignment.sql (nullable UUIDs + status/confidence).
--
-- Rules:
--   • ADD COLUMN IF NOT EXISTS only — idempotent.
--   • No data UPDATE / backfill.
--   • No FK to products (deferred until graph stability).
-- =============================================================================

BEGIN;

ALTER TABLE public.amazon_fba_inventory
  ADD COLUMN IF NOT EXISTS resolved_product_id            uuid,
  ADD COLUMN IF NOT EXISTS resolved_catalog_product_id    uuid,
  ADD COLUMN IF NOT EXISTS identifier_resolution_status   text,
  ADD COLUMN IF NOT EXISTS identifier_resolution_confidence numeric(10, 4);

COMMENT ON COLUMN public.amazon_fba_inventory.resolved_product_id IS
  'Optional: products.id resolved via product_identifier_map / resolver after import.';
COMMENT ON COLUMN public.amazon_fba_inventory.resolved_catalog_product_id IS
  'Optional: catalog_products.id resolved via product_identifier_map / resolver.';
COMMENT ON COLUMN public.amazon_fba_inventory.identifier_resolution_status IS
  'resolved | ambiguous | unresolved - set by resolver pipeline; not backfilled in this migration.';
COMMENT ON COLUMN public.amazon_fba_inventory.identifier_resolution_confidence IS
  '0-1 style confidence from resolver (numeric(10,4)); nullable until populated.';

CREATE INDEX IF NOT EXISTS idx_amazon_fba_inventory_org_resolved_product
  ON public.amazon_fba_inventory (organization_id, resolved_product_id)
  WHERE resolved_product_id IS NOT NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
