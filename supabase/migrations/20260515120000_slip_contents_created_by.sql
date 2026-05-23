-- Operator audit: who authored each packing-slip line row (BOX intake snapshot).

ALTER TABLE public.slip_contents ADD COLUMN IF NOT EXISTS created_by uuid;

COMMENT ON COLUMN public.slip_contents.created_by IS
  'Profile UUID of the operator who wrote this slip_contents row (BOX intake save).';

CREATE INDEX IF NOT EXISTS idx_slip_contents_created_by
  ON public.slip_contents (created_by)
  WHERE created_by IS NOT NULL;

NOTIFY pgrst, 'reload schema';
