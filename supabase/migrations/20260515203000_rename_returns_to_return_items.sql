-- Rename legacy `public.returns` to `public.return_items` (idempotent for DBs already renamed).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'returns'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'return_items'
  ) THEN
    ALTER TABLE public.returns RENAME TO return_items;
  END IF;
END $$;
