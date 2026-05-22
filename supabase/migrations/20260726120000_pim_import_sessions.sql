-- Persistent PIM async import sessions (1:1 with raw_report_uploads for chunked Product Master).
-- Canonical lifecycle + metrics for history UI; file bytes remain on raw_report_uploads + storage.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pim_import_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  store_id uuid NOT NULL,
  upload_id uuid NOT NULL UNIQUE REFERENCES public.raw_report_uploads (id) ON DELETE CASCADE,
  import_type text NOT NULL DEFAULT 'pim_product_master',
  source_filename text NOT NULL DEFAULT '',
  uploaded_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_requested_at timestamptz,
  status text NOT NULL DEFAULT 'uploaded',
  progress_percent integer NOT NULL DEFAULT 0,
  current_step text NOT NULL DEFAULT '',
  total_rows integer,
  processed_rows integer NOT NULL DEFAULT 0,
  accepted_rows integer,
  dirty_rows integer,
  skipped_rows integer,
  ambiguous_rows integer,
  conflict_rows integer,
  preview_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  apply_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  frozen_plan jsonb,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT pim_import_sessions_status_check CHECK (
    status = ANY (ARRAY[
      'uploaded'::text,
      'preview_running'::text,
      'preview_ready'::text,
      'importing'::text,
      'completed'::text,
      'failed'::text,
      'cancelled'::text
    ])
  ),
  CONSTRAINT pim_import_sessions_progress_check CHECK (
    progress_percent >= 0 AND progress_percent <= 100
  )
);

CREATE INDEX IF NOT EXISTS idx_pim_import_sessions_org_store_created
  ON public.pim_import_sessions (organization_id, store_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pim_import_sessions_org_status_updated
  ON public.pim_import_sessions (organization_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pim_import_sessions_upload_id
  ON public.pim_import_sessions (upload_id);

COMMENT ON TABLE public.pim_import_sessions IS
  'PIM Product Master chunked import session state; one row per raw_report_uploads PIM async upload.';

ALTER TABLE public.pim_import_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pim_import_sessions_all_own_org"
  ON public.pim_import_sessions FOR ALL
  USING (organization_id = public.get_my_organization_id())
  WITH CHECK (organization_id = public.get_my_organization_id());

-- Retention cleanup: terminal sessions older than interval -> delete upload row (cascades session).
CREATE OR REPLACE FUNCTION public.cleanup_pim_import_sessions(
  retention_interval interval DEFAULT interval '30 days',
  abandoned_preview interval DEFAULT interval '24 hours'
)
RETURNS TABLE(deleted_uploads bigint, marked_abandoned bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n_del bigint := 0;
  n_ab bigint := 0;
BEGIN
  WITH doomed AS (
    SELECT s.upload_id
    FROM public.pim_import_sessions s
    WHERE s.status IN ('completed', 'failed', 'cancelled')
      AND s.updated_at < now() - retention_interval
  )
  DELETE FROM public.raw_report_uploads r
  WHERE r.id IN (SELECT upload_id FROM doomed)
    AND r.report_type = 'pim_product_master';

  GET DIAGNOSTICS n_del = ROW_COUNT;

  UPDATE public.pim_import_sessions s
  SET
    status = 'failed',
    last_error = 'abandoned_preview',
    updated_at = now()
  WHERE s.status = 'preview_running'
    AND s.updated_at < now() - abandoned_preview;

  GET DIAGNOSTICS n_ab = ROW_COUNT;

  deleted_uploads := n_del;
  marked_abandoned := n_ab;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.cleanup_pim_import_sessions IS
  'Deletes old terminal pim_product_master uploads (and cascaded pim_import_sessions). '
  'Marks stale preview_running sessions as failed (abandoned_preview). Schedule via pg_cron if desired.';

REVOKE ALL ON FUNCTION public.cleanup_pim_import_sessions(interval, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cleanup_pim_import_sessions(interval, interval) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
