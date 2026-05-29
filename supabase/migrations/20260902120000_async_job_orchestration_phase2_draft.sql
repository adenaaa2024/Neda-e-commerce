-- =============================================================================
-- ASYNC JOB ORCHESTRATION — PHASE 2 DRAFT (do not apply without approval)
-- Adds dequeue helper + pim_import_sessions bridge + scheduled drain hook target
-- =============================================================================

BEGIN;

ALTER TABLE public.pim_import_sessions
  ADD COLUMN IF NOT EXISTS background_job_id uuid REFERENCES public.background_jobs (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pim_import_sessions_background_job
  ON public.pim_import_sessions (background_job_id)
  WHERE background_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_next_background_job(
  p_worker_id text,
  p_job_types text[] DEFAULT NULL,
  p_lease_seconds integer DEFAULT 120
)
RETURNS SETOF public.background_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.background_jobs%ROWTYPE;
BEGIN
  PERFORM public.reclaim_stale_background_jobs(interval '30 seconds');

  SELECT * INTO v_job
  FROM public.background_jobs j
  WHERE j.status = 'queued'
    AND (j.scheduled_at IS NULL OR j.scheduled_at <= now())
    AND (p_job_types IS NULL OR j.job_type = ANY (p_job_types))
    AND j.cancel_requested_at IS NULL
  ORDER BY j.priority DESC, j.created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.background_jobs
  SET status = 'running',
      locked_at = now(),
      locked_by = p_worker_id,
      lock_expires_at = now() + make_interval(secs => p_lease_seconds),
      started_at = COALESCE(started_at, now()),
      updated_at = now()
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN NEXT v_job;
END;
$$;

COMMENT ON FUNCTION public.claim_next_background_job IS
  'Cron/worker drain: atomically lease highest-priority queued job.';

GRANT EXECUTE ON FUNCTION public.claim_next_background_job(text, text[], integer) TO service_role;

COMMIT;
