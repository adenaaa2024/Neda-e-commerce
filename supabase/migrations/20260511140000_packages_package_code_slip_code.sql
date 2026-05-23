-- BOX scan: split physical carton id (`package_code`) from packing-slip document id (`slip_code`).
-- Renames legacy `packages.slip_id` (migration 20260511120000) → `package_code`.
-- Adds `slip_code` on `packages` and denormalized `slip_code` on `slip_contents` rows.

DROP INDEX IF EXISTS public.idx_packages_org_slip_id;

ALTER TABLE public.packages RENAME COLUMN slip_id TO package_code;

ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS slip_code text DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_packages_org_package_code
  ON public.packages (organization_id, package_code)
  WHERE deleted_at IS NULL AND package_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_packages_org_slip_code
  ON public.packages (organization_id, slip_code)
  WHERE deleted_at IS NULL AND slip_code IS NOT NULL;

COMMENT ON COLUMN public.packages.package_code IS
  'Physical carton / box barcode applied at operator BOX intake (lock field).';

COMMENT ON COLUMN public.packages.slip_photo_urls IS
  'Up to 3 URLs — packing slip pages for GPT Vision (slip_code + line items).';

COMMENT ON COLUMN public.packages.slip_code IS
  'Printed packing-slip identifier (often S…) from GPT Vision or manual entry.';

ALTER TABLE public.slip_contents ADD COLUMN IF NOT EXISTS slip_code text DEFAULT NULL;

COMMENT ON COLUMN public.slip_contents.slip_code IS
  'Packing-slip document id for this line (denormalized for traceability).';

NOTIFY pgrst, 'reload schema';
