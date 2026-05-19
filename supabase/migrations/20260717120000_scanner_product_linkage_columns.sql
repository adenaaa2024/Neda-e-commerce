-- NEXT-SCANNER-02: nullable product linkage + resolution metadata for scanner flows.
-- Additive only. Does NOT drop tables, delete data, or tighten NOT NULL.
-- Apply only after operator approval on production.

BEGIN;

-- ── expected_packages (removal expectation lines) ─────────────────────────
ALTER TABLE public.expected_packages
  ADD COLUMN IF NOT EXISTS expected_product_id uuid,
  ADD COLUMN IF NOT EXISTS resolved_product_id uuid,
  ADD COLUMN IF NOT EXISTS resolved_catalog_product_id uuid,
  ADD COLUMN IF NOT EXISTS identifier_resolution_status text,
  ADD COLUMN IF NOT EXISTS identifier_resolution_confidence numeric(10, 4),
  ADD COLUMN IF NOT EXISTS identifier_resolution_source text,
  ADD COLUMN IF NOT EXISTS identifier_resolution_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS product_match_status text,
  ADD COLUMN IF NOT EXISTS product_review_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS product_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS product_resolved_by uuid;

COMMENT ON COLUMN public.expected_packages.expected_product_id IS
  'Optional FK to public.products — planner/operator expected catalog row for this expectation line.';
COMMENT ON COLUMN public.expected_packages.resolved_product_id IS
  'Optional FK to public.products — last deterministic resolution for identifiers on this line.';
COMMENT ON COLUMN public.expected_packages.resolved_catalog_product_id IS
  'Optional public.catalog_products.id when resolution came via listing bridge.';
COMMENT ON COLUMN public.expected_packages.identifier_resolution_status IS
  'resolved | ambiguous | unresolved — scanner-safe deterministic tier only.';
COMMENT ON COLUMN public.expected_packages.product_match_status IS
  'Optional reconciliation vs scan layer: match | mismatch | unknown.';
COMMENT ON COLUMN public.expected_packages.product_review_required IS
  'Operator must confirm product when true (ambiguous identifiers, mismatch, etc.).';

DO $$
BEGIN
  IF to_regclass('public.products') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'expected_packages_expected_product_id_fkey'
    ) THEN
      ALTER TABLE public.expected_packages
        ADD CONSTRAINT expected_packages_expected_product_id_fkey
        FOREIGN KEY (expected_product_id) REFERENCES public.products (id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'expected_packages_resolved_product_id_fkey'
    ) THEN
      ALTER TABLE public.expected_packages
        ADD CONSTRAINT expected_packages_resolved_product_id_fkey
        FOREIGN KEY (resolved_product_id) REFERENCES public.products (id) ON DELETE SET NULL;
    END IF;
    IF to_regclass('public.catalog_products') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint WHERE conname = 'expected_packages_resolved_catalog_product_id_fkey'
       ) THEN
      ALTER TABLE public.expected_packages
        ADD CONSTRAINT expected_packages_resolved_catalog_product_id_fkey
        FOREIGN KEY (resolved_catalog_product_id) REFERENCES public.catalog_products (id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_expected_packages_org_store_resolved_product
  ON public.expected_packages (organization_id, store_id, resolved_product_id)
  WHERE resolved_product_id IS NOT NULL;

-- ── return_items (scanner / receive physical units) ─────────────────────────
ALTER TABLE public.return_items
  ADD COLUMN IF NOT EXISTS expected_item_id uuid,
  ADD COLUMN IF NOT EXISTS expected_product_id uuid,
  ADD COLUMN IF NOT EXISTS scanned_product_id uuid,
  ADD COLUMN IF NOT EXISTS resolved_product_id uuid,
  ADD COLUMN IF NOT EXISTS resolved_catalog_product_id uuid,
  ADD COLUMN IF NOT EXISTS identifier_resolution_status text,
  ADD COLUMN IF NOT EXISTS identifier_resolution_confidence numeric(10, 4),
  ADD COLUMN IF NOT EXISTS identifier_resolution_source text,
  ADD COLUMN IF NOT EXISTS identifier_resolution_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS product_match_status text,
  ADD COLUMN IF NOT EXISTS product_review_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS product_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS product_resolved_by uuid;

COMMENT ON COLUMN public.return_items.expected_item_id IS
  'FK to public.expected_packages.id — expectation row this unit was received against.';
COMMENT ON COLUMN public.return_items.expected_product_id IS
  'Denormalized expected products.id from the expectation row at receive time.';
COMMENT ON COLUMN public.return_items.scanned_product_id IS
  'Optional products.id from an explicit scan/barcode path (distinct from legacy product_id).';
COMMENT ON COLUMN public.return_items.resolved_product_id IS
  'Deterministic canonical products.id from identifier bridge / direct match.';
COMMENT ON COLUMN public.return_items.resolved_catalog_product_id IS
  'Optional catalog_products.id when listing bridge contributed.';
COMMENT ON COLUMN public.return_items.product_match_status IS
  'match | mismatch | unknown — compare expected_product_id vs resolved path.';

DO $$
BEGIN
  IF to_regclass('public.expected_packages') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_items_expected_item_id_fkey') THEN
    ALTER TABLE public.return_items
      ADD CONSTRAINT return_items_expected_item_id_fkey
      FOREIGN KEY (expected_item_id) REFERENCES public.expected_packages (id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.products') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_items_expected_product_id_fkey') THEN
      ALTER TABLE public.return_items
        ADD CONSTRAINT return_items_expected_product_id_fkey
        FOREIGN KEY (expected_product_id) REFERENCES public.products (id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_items_scanned_product_id_fkey') THEN
      ALTER TABLE public.return_items
        ADD CONSTRAINT return_items_scanned_product_id_fkey
        FOREIGN KEY (scanned_product_id) REFERENCES public.products (id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_items_resolved_product_id_fkey') THEN
      ALTER TABLE public.return_items
        ADD CONSTRAINT return_items_resolved_product_id_fkey
        FOREIGN KEY (resolved_product_id) REFERENCES public.products (id) ON DELETE SET NULL;
    END IF;
    IF to_regclass('public.catalog_products') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'return_items_resolved_catalog_product_id_fkey') THEN
      ALTER TABLE public.return_items
        ADD CONSTRAINT return_items_resolved_catalog_product_id_fkey
        FOREIGN KEY (resolved_catalog_product_id) REFERENCES public.catalog_products (id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_return_items_expected_item
  ON public.return_items (expected_item_id)
  WHERE expected_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_return_items_org_store_resolved_product
  ON public.return_items (organization_id, store_id, resolved_product_id)
  WHERE resolved_product_id IS NOT NULL AND deleted_at IS NULL;

-- ── slip_contents (BOX scan lines) ──────────────────────────────────────────
ALTER TABLE public.slip_contents
  ADD COLUMN IF NOT EXISTS ocr_text text,
  ADD COLUMN IF NOT EXISTS ocr_product_name text,
  ADD COLUMN IF NOT EXISTS ocr_confidence numeric(10, 4),
  ADD COLUMN IF NOT EXISTS parsed_asin text,
  ADD COLUMN IF NOT EXISTS parsed_fnsku text,
  ADD COLUMN IF NOT EXISTS parsed_sku text,
  ADD COLUMN IF NOT EXISTS parsed_upc text,
  ADD COLUMN IF NOT EXISTS resolved_product_id uuid,
  ADD COLUMN IF NOT EXISTS resolved_catalog_product_id uuid,
  ADD COLUMN IF NOT EXISTS identifier_resolution_status text,
  ADD COLUMN IF NOT EXISTS identifier_resolution_confidence numeric(10, 4),
  ADD COLUMN IF NOT EXISTS identifier_resolution_source text,
  ADD COLUMN IF NOT EXISTS identifier_resolution_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS product_review_required boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.slip_contents.ocr_text IS
  'Raw OCR / vision text for this slip line when captured separately from description.';
COMMENT ON COLUMN public.slip_contents.ocr_product_name IS
  'Vision-extracted product title — not used for deterministic-only resolution.';
COMMENT ON COLUMN public.slip_contents.parsed_asin IS
  'Normalized ASIN token from OCR/parser (may duplicate legacy columns when aligned).';
COMMENT ON COLUMN public.slip_contents.resolved_product_id IS
  'Optional products.id after safe deterministic identifier resolution.';

DO $$
BEGIN
  IF to_regclass('public.products') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slip_contents_resolved_product_id_fkey') THEN
    ALTER TABLE public.slip_contents
      ADD CONSTRAINT slip_contents_resolved_product_id_fkey
      FOREIGN KEY (resolved_product_id) REFERENCES public.products (id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.catalog_products') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slip_contents_resolved_catalog_product_id_fkey') THEN
    ALTER TABLE public.slip_contents
      ADD CONSTRAINT slip_contents_resolved_catalog_product_id_fkey
      FOREIGN KEY (resolved_catalog_product_id) REFERENCES public.catalog_products (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_slip_contents_package_resolved
  ON public.slip_contents (package_id, resolved_product_id)
  WHERE resolved_product_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
