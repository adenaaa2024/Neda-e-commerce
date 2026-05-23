-- BOX SCAN (package): evidence arrays + printed slip id for operator-mobile receiving.
ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS outside_photo_urls text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS inside_photo_urls text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS slip_photo_urls text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS slip_id text DEFAULT NULL;

COMMENT ON COLUMN public.packages.outside_photo_urls IS
  'Up to 3 URLs — exterior / damage documentation for this BOX.';

COMMENT ON COLUMN public.packages.inside_photo_urls IS
  'Up to 3 URLs — interior contents documentation for this BOX.';

COMMENT ON COLUMN public.packages.slip_photo_urls IS
  'Up to 3 URLs — packing slip pages for GPT Vision (slip_id + line items).';

COMMENT ON COLUMN public.packages.slip_id IS
  'Printed slip / removal barcode starting with S when captured from slip or vision.';

CREATE INDEX IF NOT EXISTS idx_packages_org_slip_id
  ON public.packages (organization_id, slip_id)
  WHERE deleted_at IS NULL AND slip_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
