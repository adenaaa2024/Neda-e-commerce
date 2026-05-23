-- Adds line-level flags JSON (e.g. `{ "missing": true }`) for BOX slip rows.
-- If you see PostgREST "Could not find the 'notes' column of 'slip_contents' in the schema cache",
-- apply pending migrations (`supabase db push` / SQL editor) so this runs on your project.
ALTER TABLE public.slip_contents ADD COLUMN IF NOT EXISTS notes text;

NOTIFY pgrst, 'reload schema';
