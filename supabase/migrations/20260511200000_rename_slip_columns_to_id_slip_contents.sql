-- Align base tables with app code: `packages.slip_code` → `id_slip_contents`,
-- `expected_packages.allocation_box_code` → `id_slip_contents`.
-- Idempotent: skips when the target column already exists (already applied manually).

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'packages' AND c.column_name = 'slip_code'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'packages' AND c.column_name = 'id_slip_contents'
  ) THEN
    ALTER TABLE public.packages RENAME COLUMN slip_code TO id_slip_contents;
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'expected_packages' AND c.column_name = 'allocation_box_code'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = 'expected_packages' AND c.column_name = 'id_slip_contents'
  ) THEN
    ALTER TABLE public.expected_packages RENAME COLUMN allocation_box_code TO id_slip_contents;
  END IF;
END$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
