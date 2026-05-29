-- =============================================================================
-- ASYNC JOB ORCHESTRATION — PHASE 1 (staging apply)
-- Source: async-import-job-orchestration-foundation/20260528T235727Z/migration-draft.sql
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.background_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  priority smallint NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  idempotency_key text NOT NULL,
  requested_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  cancel_requested_at timestamptz,
  progress_pct smallint NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  current_step_index integer NOT NULL DEFAULT 0 CHECK (current_step_index >= 0),
  resource_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error_code text,
  last_error_detail text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  locked_at timestamptz,
  locked_by text,
  lock_expires_at timestamptz,
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT background_jobs_status_chk CHECK (
    status = ANY (ARRAY['queued','running','completed','failed','cancelled']::text[])
  ),
  CONSTRAINT background_jobs_type_chk CHECK (
    job_type = ANY (
      ARRAY[
        'product_import',
        'product_enrichment',
        'amazon_fetch',
        'amazon_domain_sync',
        'orchestration',
        'resolver_backfill',
        'claim_generation',
        'image_processing'
      ]::text[]
    )
  ),
  CONSTRAINT background_jobs_org_type_idempotency_key UNIQUE (organization_id, job_type, idempotency_key)
);

COMMENT ON TABLE public.background_jobs IS
  'Durable control plane for long-running import/update jobs (resumable, cancelable, auditable).';

CREATE INDEX IF NOT EXISTS idx_background_jobs_org_status_priority
  ON public.background_jobs (organization_id, status, priority DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_background_jobs_lock_expires
  ON public.background_jobs (lock_expires_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_background_jobs_scheduled
  ON public.background_jobs (scheduled_at)
  WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS public.job_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.background_jobs (id) ON DELETE CASCADE,
  step_index integer NOT NULL CHECK (step_index >= 0),
  step_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  progress_pct smallint NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt jsonb NOT NULL DEFAULT '{"count":0}'::jsonb,
  budget_ms integer NOT NULL DEFAULT 25000 CHECK (budget_ms > 0),
  worker_kind text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_steps_status_chk CHECK (
    status = ANY (ARRAY['pending','running','completed','failed','skipped','cancelled']::text[])
  ),
  CONSTRAINT job_steps_job_step_index_key UNIQUE (job_id, step_index)
);

COMMENT ON TABLE public.job_steps IS
  'Ordered resumable steps within a background_job; cursor holds checkpoint for tick workers.';

CREATE INDEX IF NOT EXISTS idx_job_steps_job_status
  ON public.job_steps (job_id, status);

CREATE TABLE IF NOT EXISTS public.job_locks (
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  resource_key text NOT NULL,
  job_id uuid NOT NULL REFERENCES public.background_jobs (id) ON DELETE CASCADE,
  locked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, resource_key)
);

COMMENT ON TABLE public.job_locks IS
  'Short-lived mutex per org+resource_key; prevents concurrent domain sync / rebuild races.';

CREATE TABLE IF NOT EXISTS public.job_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.background_jobs (id) ON DELETE CASCADE,
  step_id uuid REFERENCES public.job_steps (id) ON DELETE SET NULL,
  event_type text NOT NULL,
  message text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_events_type_chk CHECK (
    event_type = ANY (
      ARRAY[
        'enqueued',
        'tick_start',
        'tick_end',
        'progress',
        'warning',
        'error',
        'cancel_requested',
        'cancelled',
        'completed',
        'retry'
      ]::text[]
    )
  )
);

COMMENT ON TABLE public.job_events IS
  'Append-only job timeline for operator UI and post-mortems.';

CREATE INDEX IF NOT EXISTS idx_job_events_job_created
  ON public.job_events (job_id, created_at ASC);

ALTER TABLE public.raw_report_uploads
  ADD COLUMN IF NOT EXISTS background_job_id uuid REFERENCES public.background_jobs (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_raw_report_uploads_background_job
  ON public.raw_report_uploads (background_job_id)
  WHERE background_job_id IS NOT NULL;

ALTER TABLE public.file_processing_status
  ADD COLUMN IF NOT EXISTS background_job_id uuid REFERENCES public.background_jobs (id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.trg_background_jobs_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  new.updated_at := now();
  RETURN new;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_background_jobs_updated_at ON public.background_jobs;
CREATE TRIGGER trg_background_jobs_updated_at
  BEFORE UPDATE ON public.background_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_background_jobs_updated_at();

CREATE OR REPLACE FUNCTION public.trg_job_steps_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  new.updated_at := now();
  RETURN new;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_job_steps_updated_at ON public.job_steps;
CREATE TRIGGER trg_job_steps_updated_at
  BEFORE UPDATE ON public.job_steps
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_job_steps_updated_at();

CREATE OR REPLACE FUNCTION public.reclaim_stale_background_jobs(p_grace interval DEFAULT interval '2 minutes')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.background_jobs
  SET status = 'queued',
      locked_at = NULL,
      locked_by = NULL,
      lock_expires_at = NULL,
      updated_at = now()
  WHERE status = 'running'
    AND lock_expires_at IS NOT NULL
    AND lock_expires_at < now() - p_grace;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

ALTER TABLE public.background_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "background_jobs: org members can select"
  ON public.background_jobs FOR SELECT
  USING (
    organization_id IN (SELECT organization_id FROM public.profiles WHERE id = auth.uid())
  );

CREATE POLICY IF NOT EXISTS "background_jobs: org members can insert"
  ON public.background_jobs FOR INSERT
  WITH CHECK (
    organization_id IN (SELECT organization_id FROM public.profiles WHERE id = auth.uid())
  );

CREATE POLICY IF NOT EXISTS "background_jobs: org members can update"
  ON public.background_jobs FOR UPDATE
  USING (
    organization_id IN (SELECT organization_id FROM public.profiles WHERE id = auth.uid())
  );

CREATE POLICY IF NOT EXISTS "background_jobs: service role bypass"
  ON public.background_jobs AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "job_steps: org members via job"
  ON public.job_steps FOR SELECT
  USING (
    job_id IN (
      SELECT id FROM public.background_jobs
      WHERE organization_id IN (SELECT organization_id FROM public.profiles WHERE id = auth.uid())
    )
  );

CREATE POLICY IF NOT EXISTS "job_steps: service role bypass"
  ON public.job_steps AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "job_locks: org members via job"
  ON public.job_locks FOR SELECT
  USING (
    organization_id IN (SELECT organization_id FROM public.profiles WHERE id = auth.uid())
  );

CREATE POLICY IF NOT EXISTS "job_locks: service role bypass"
  ON public.job_locks AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "job_events: org members via job"
  ON public.job_events FOR SELECT
  USING (
    job_id IN (
      SELECT id FROM public.background_jobs
      WHERE organization_id IN (SELECT organization_id FROM public.profiles WHERE id = auth.uid())
    )
  );

CREATE POLICY IF NOT EXISTS "job_events: service role bypass"
  ON public.job_events AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMIT;
