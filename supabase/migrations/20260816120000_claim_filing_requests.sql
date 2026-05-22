-- =============================================================================
-- NEXT-CLAIM-FILING-AGENT-02 — Safe filing handoff layer (additive).
-- Does not alter claim_submissions columns or semantics used by legacy/Python flow.
-- Apply when approved (supabase db push / migration up / SQL editor).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Filing requests (handoff envelope for external agent; no portal execution here)
-- -----------------------------------------------------------------------------
CREATE TABLE public.claim_filing_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores (id) ON DELETE CASCADE,
  claim_review_work_item_id uuid REFERENCES public.claim_review_work_items (id) ON DELETE SET NULL,
  claim_candidate_draft_id uuid REFERENCES public.claim_candidate_drafts (id) ON DELETE SET NULL,
  claim_submission_id uuid REFERENCES public.claim_submissions (id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  automation_mode text NOT NULL DEFAULT 'disabled',
  status text NOT NULL DEFAULT 'pending_approval',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_case_id text,
  submission_status text,
  portal text,
  artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_reason text,
  failure_category text,
  requested_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  approved_at timestamptz,
  external_agent_endpoint text,
  secret_reference text,
  callback_secret_reference text,
  agent_timeout_ms integer,
  agent_max_retries integer,
  environment text NOT NULL DEFAULT 'sandbox',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_filing_requests_idempotency_uniq UNIQUE (organization_id, idempotency_key),
  CONSTRAINT claim_filing_requests_anchor_chk CHECK (
    claim_review_work_item_id IS NOT NULL
    OR claim_submission_id IS NOT NULL
    OR claim_candidate_draft_id IS NOT NULL
  ),
  CONSTRAINT claim_filing_requests_automation_mode_chk CHECK (automation_mode IN (
    'disabled',
    'manual_only',
    'prepare_only',
    'submit_with_confirmation',
    'full_auto_reserved'
  )),
  CONSTRAINT claim_filing_requests_status_chk CHECK (status IN (
    'draft',
    'pending_approval',
    'approved',
    'queued',
    'terminal_success',
    'terminal_failure',
    'cancelled'
  )),
  CONSTRAINT claim_filing_requests_environment_chk CHECK (environment IN ('sandbox', 'production')),
  CONSTRAINT claim_filing_requests_agent_timeout_chk CHECK (agent_timeout_ms IS NULL OR agent_timeout_ms > 0),
  CONSTRAINT claim_filing_requests_agent_retries_chk CHECK (agent_max_retries IS NULL OR agent_max_retries >= 0)
);

COMMENT ON TABLE public.claim_filing_requests IS
  'NEXT-CLAIM-FILING-AGENT-02: handoff envelope for external filing worker; does not replace claim_submissions.';

CREATE INDEX idx_claim_filing_requests_org_store_status
  ON public.claim_filing_requests (organization_id, store_id, status);

CREATE INDEX idx_claim_filing_requests_work_item
  ON public.claim_filing_requests (claim_review_work_item_id)
  WHERE claim_review_work_item_id IS NOT NULL;

CREATE INDEX idx_claim_filing_requests_submission
  ON public.claim_filing_requests (claim_submission_id)
  WHERE claim_submission_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_claim_filing_requests_set_updated_at ON public.claim_filing_requests;
CREATE TRIGGER trg_claim_filing_requests_set_updated_at
  BEFORE UPDATE ON public.claim_filing_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Append-only events (audit)
-- -----------------------------------------------------------------------------
CREATE TABLE public.claim_filing_request_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_request_id uuid NOT NULL REFERENCES public.claim_filing_requests (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_user_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'app',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_filing_request_events_type_chk CHECK (event_type IN (
    'created',
    'approved',
    'callback_received',
    'status_updated',
    'cancelled'
  )),
  CONSTRAINT claim_filing_request_events_source_chk CHECK (source IN ('app', 'agent', 'callback', 'system'))
);

COMMENT ON TABLE public.claim_filing_request_events IS
  'Append-only audit for claim_filing_requests; no automated marketplace submission in DB.';

CREATE INDEX idx_claim_filing_request_events_org_created
  ON public.claim_filing_request_events (organization_id, created_at DESC);

CREATE INDEX idx_claim_filing_request_events_request
  ON public.claim_filing_request_events (filing_request_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE public.claim_filing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_filing_request_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claim_filing_requests_service_role_all" ON public.claim_filing_requests;
CREATE POLICY "claim_filing_requests_service_role_all"
  ON public.claim_filing_requests
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "claim_filing_requests_select_own_org" ON public.claim_filing_requests;
CREATE POLICY "claim_filing_requests_select_own_org"
  ON public.claim_filing_requests
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "claim_filing_request_events_service_role_all" ON public.claim_filing_request_events;
CREATE POLICY "claim_filing_request_events_service_role_all"
  ON public.claim_filing_request_events
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "claim_filing_request_events_select_own_org" ON public.claim_filing_request_events;
CREATE POLICY "claim_filing_request_events_select_own_org"
  ON public.claim_filing_request_events
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_filing_requests TO service_role;
GRANT SELECT ON public.claim_filing_requests TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_filing_request_events TO service_role;
GRANT SELECT ON public.claim_filing_request_events TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
