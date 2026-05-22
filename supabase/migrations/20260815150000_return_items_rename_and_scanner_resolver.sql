-- =============================================================================
-- 20260815150000 — Canonical operational scanner line table: `return_items`
-- (rename from `returns`) + nullable product resolver columns on return_items,
-- expected_items, and slip_contents (additive / idempotent only).
-- =============================================================================

BEGIN;

-- 1) Rename legacy table (no drop/recreate). Idempotent for re-apply.
DO $$
BEGIN
  IF to_regclass('public.returns') IS NOT NULL AND to_regclass('public.return_items') IS NULL THEN
    ALTER TABLE public.returns RENAME TO return_items;
  END IF;
END $$;

-- 2) Resolver columns — align with amazon_fba_inventory / ledger pattern (no FK to products).
ALTER TABLE public.return_items
  ADD COLUMN IF NOT EXISTS resolved_product_id uuid,
  ADD COLUMN IF NOT EXISTS resolved_catalog_product_id uuid,
  ADD COLUMN IF NOT EXISTS identifier_resolution_status text,
  ADD COLUMN IF NOT EXISTS identifier_resolution_confidence numeric(10, 4);

COMMENT ON COLUMN public.return_items.resolved_product_id IS
  'Nullable products.id from deterministic identifier map match; null when ambiguous/unresolved/mismatch.';
COMMENT ON COLUMN public.return_items.resolved_catalog_product_id IS
  'Nullable catalog_products.id from the same match row when present.';
COMMENT ON COLUMN public.return_items.identifier_resolution_status IS
  'resolved | ambiguous | unresolved | mismatch — set on scanner save; mismatch when legacy product_id disagrees with resolver.';
COMMENT ON COLUMN public.return_items.identifier_resolution_confidence IS
  '0–1 style confidence from resolver tiers; null until populated.';

CREATE INDEX IF NOT EXISTS idx_return_items_org_resolved_product
  ON public.return_items (organization_id, resolved_product_id)
  WHERE resolved_product_id IS NOT NULL;

-- 3) Expected pallet line items (removal / ETL expected_items — table optional per env)
DO $$
BEGIN
  IF to_regclass('public.expected_items') IS NOT NULL THEN
    ALTER TABLE public.expected_items
      ADD COLUMN IF NOT EXISTS resolved_product_id uuid,
      ADD COLUMN IF NOT EXISTS resolved_catalog_product_id uuid,
      ADD COLUMN IF NOT EXISTS identifier_resolution_status text,
      ADD COLUMN IF NOT EXISTS identifier_resolution_confidence numeric(10, 4);
    EXECUTE
      'COMMENT ON COLUMN public.expected_items.resolved_product_id IS '
      '''Optional products.id from deterministic resolver; null when ambiguous/unresolved/mismatch.''';
    EXECUTE
      'COMMENT ON COLUMN public.expected_items.identifier_resolution_status IS '
      '''resolved | ambiguous | unresolved | mismatch — populated when resolver runs for this row.''';
  END IF;
END $$;

-- 4) slip_contents (may exist only in some environments — guard with to_regclass)
DO $$
BEGIN
  IF to_regclass('public.slip_contents') IS NOT NULL THEN
    EXECUTE $slip$
      ALTER TABLE public.slip_contents
        ADD COLUMN IF NOT EXISTS resolved_product_id uuid,
        ADD COLUMN IF NOT EXISTS resolved_catalog_product_id uuid,
        ADD COLUMN IF NOT EXISTS identifier_resolution_status text,
        ADD COLUMN IF NOT EXISTS identifier_resolution_confidence numeric(10, 4)
    $slip$;
    EXECUTE
      'COMMENT ON COLUMN public.slip_contents.resolved_product_id IS '
      '''Nullable products.id from deterministic slip-line resolver; null when ambiguous/unresolved/mismatch.''';
    EXECUTE
      'COMMENT ON COLUMN public.slip_contents.identifier_resolution_status IS '
      '''resolved | ambiguous | unresolved | mismatch — populated when resolver runs for this slip line.''';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
