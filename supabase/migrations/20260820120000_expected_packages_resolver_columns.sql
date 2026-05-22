-- EXPECTED-PACKAGES-RESOLVER-BACKFILL-V180 — nullable resolver quad on expected_packages (idempotent).
-- Apply on staging via migration or v180 script; production blocked until separate approval.

ALTER TABLE public.expected_packages
  ADD COLUMN IF NOT EXISTS resolved_product_id uuid,
  ADD COLUMN IF NOT EXISTS resolved_catalog_product_id uuid,
  ADD COLUMN IF NOT EXISTS identifier_resolution_status text,
  ADD COLUMN IF NOT EXISTS identifier_resolution_confidence numeric(10, 4);

COMMENT ON COLUMN public.expected_packages.resolved_product_id IS
  'Nullable products.id from deterministic product_identifier_map match (V180 backfill).';

COMMENT ON COLUMN public.expected_packages.resolved_catalog_product_id IS
  'Nullable catalog_products.id from the same match row when present.';

COMMENT ON COLUMN public.expected_packages.identifier_resolution_status IS
  'resolved | matched | ambiguous | unresolved — exact-tier backfill only.';

COMMENT ON COLUMN public.expected_packages.identifier_resolution_confidence IS
  'Tier confidence 0–1 from V180 backfill; null until populated.';

CREATE INDEX IF NOT EXISTS idx_expected_packages_org_resolved
  ON public.expected_packages (organization_id, resolved_product_id)
  WHERE resolved_product_id IS NOT NULL;
