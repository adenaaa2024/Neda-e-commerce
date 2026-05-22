-- =============================================================================
-- 20260815151000 — Ensure legacy `product_id` exists on operational return lines
-- (table may still be `returns` if rename migration not applied yet).
-- =============================================================================

DO $$
BEGIN
  IF to_regclass('public.return_items') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.return_items ADD COLUMN IF NOT EXISTS product_id uuid';
  ELSIF to_regclass('public.returns') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.returns ADD COLUMN IF NOT EXISTS product_id uuid';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
