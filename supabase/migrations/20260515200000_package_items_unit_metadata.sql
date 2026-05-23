-- Per-unit item scan metadata (discrepancies, traceability, evidence).

ALTER TABLE public.package_items
  ADD COLUMN IF NOT EXISTS discrepancy_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS expiry_date date,
  ADD COLUMN IF NOT EXISTS lot_number text,
  ADD COLUMN IF NOT EXISTS evidence_urls text[] NOT NULL DEFAULT ARRAY[]::text[];

COMMENT ON COLUMN public.package_items.discrepancy_tags IS
  'Operator-selected issue tags for this scanned unit (item-level only; no box-level flags).';
COMMENT ON COLUMN public.package_items.expiry_date IS
  'Expiration date when required for perishables or when Expired tag is selected.';
COMMENT ON COLUMN public.package_items.lot_number IS
  'Batch / lot number when traceability is required.';
COMMENT ON COLUMN public.package_items.evidence_urls IS
  'Public storage URLs for issue evidence photos.';

NOTIFY pgrst, 'reload schema';
