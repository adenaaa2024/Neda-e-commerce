-- Align `packages` free-text field with app: `discrepancy_note` → `notes` (operator scanner + returns).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'packages' AND column_name = 'discrepancy_note'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'packages' AND column_name = 'notes'
  ) THEN
    ALTER TABLE public.packages RENAME COLUMN discrepancy_note TO notes;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'packages' AND column_name = 'notes'
  ) THEN
    ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS notes text;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
