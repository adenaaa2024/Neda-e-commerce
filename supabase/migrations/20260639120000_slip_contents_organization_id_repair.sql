-- Repair slip_contents missing organization_id (older / hand-created tables, or CREATE IF NOT EXISTS skip).
-- Fixes: "Could not find the 'organization_id' column of 'slip_contents' in the schema cache"
-- when saving BOX intake (insert from updateOperatorIntakeBoxPackageAction).

ALTER TABLE public.slip_contents ADD COLUMN IF NOT EXISTS organization_id uuid;

UPDATE public.slip_contents sc
SET organization_id = p.organization_id
FROM public.packages p
WHERE p.id = sc.package_id
  AND sc.organization_id IS NULL;

-- Orphan line rows (no matching package) cannot satisfy NOT NULL — remove them.
DELETE FROM public.slip_contents WHERE organization_id IS NULL;

ALTER TABLE public.slip_contents ALTER COLUMN organization_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_slip_contents_organization_id
  ON public.slip_contents (organization_id);

NOTIFY pgrst, 'reload schema';
