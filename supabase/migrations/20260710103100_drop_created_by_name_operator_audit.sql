-- Operator audit uses `created_by` (UUID → profiles.id) only — remove retraced helper column when present.
ALTER TABLE public.pallets
  DROP COLUMN IF EXISTS created_by_name;

ALTER TABLE public.packages
  DROP COLUMN IF EXISTS created_by_name;
