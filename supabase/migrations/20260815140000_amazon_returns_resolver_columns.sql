-- =============================================================================
-- 20260815140000 — amazon_returns resolver columns (NEXT-UNIVERSAL-RESOLVER-04)
--
-- Aligns FBA Returns (`amazon_returns`) with the resolver column pattern used on
-- `amazon_fba_inventory` (20260813120000) — nullable UUIDs + status/confidence.
--
-- Rules:
--   • ADD COLUMN IF NOT EXISTS only — idempotent.
--   • No data UPDATE / backfill.
--   • No FK to products (deferred until graph stability).
-- =============================================================================

BEGIN;

ALTER TABLE public.amazon_returns
  ADD COLUMN IF NOT EXISTS resolved_product_id uuid,
  ADD COLUMN IF NOT EXISTS resolved_catalog_product_id uuid,
  ADD COLUMN IF NOT EXISTS identifier_resolution_status text,
  ADD COLUMN IF NOT EXISTS identifier_resolution_confidence numeric(10, 4);

COMMENT ON COLUMN public.amazon_returns.resolved_product_id IS
  'Optional: products.id resolved via product_identifier_map / resolver after import.';
COMMENT ON COLUMN public.amazon_returns.resolved_catalog_product_id IS
  'Optional: catalog_products.id resolved via product_identifier_map / resolver.';
COMMENT ON COLUMN public.amazon_returns.identifier_resolution_status IS
  'resolved | ambiguous | unresolved | matched — set by resolver pipeline; not backfilled in this migration.';
COMMENT ON COLUMN public.amazon_returns.identifier_resolution_confidence IS
  '0-1 style confidence from resolver (numeric(10,4)); nullable until populated.';

CREATE INDEX IF NOT EXISTS idx_amazon_returns_org_resolved_product
  ON public.amazon_returns (organization_id, resolved_product_id)
  WHERE resolved_product_id IS NOT NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
