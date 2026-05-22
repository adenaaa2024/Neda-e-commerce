-- 20260808120001_fps_cancel_columns.sql
-- Add cancel signal columns to file_processing_status.
-- This replaces pim_import_sessions.cancel_requested_at (table does not exist in production).
-- ETL checks this column each chunk to stop processing safely.

ALTER TABLE public.file_processing_status
  ADD COLUMN IF NOT EXISTS cancel_requested_at  timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_requested_by  uuid
    REFERENCES public.profiles (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.file_processing_status.cancel_requested_at IS
  'Set by cancel API; ETL checks this on each chunk to stop processing safely.';
COMMENT ON COLUMN public.file_processing_status.cancel_requested_by IS
  'Profile id of the user who requested cancellation.';
