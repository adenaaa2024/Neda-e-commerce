-- =============================================================================
-- CLAIM-INBOX-AUDIT-09 — public.claim_candidate_drafts
-- V2 generator staging (side-by-side with legacy claim_candidates; no data move).
-- =============================================================================
-- Apply manually: `supabase db push` / `supabase migration up` / SQL editor
-- when explicitly approved. This file is committed only; agent does not run it.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Table
-- -----------------------------------------------------------------------------
CREATE TABLE public.claim_candidate_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,
  source_table text NOT NULL,
  source_row_id text NOT NULL,
  claim_family text NOT NULL,
  claim_reason text NOT NULL,
  evidence_status text NOT NULL,
  confidence_score numeric(6,4),
  sku text,
  asin text,
  fnsku text,
  product_id uuid REFERENCES public.products (id) ON DELETE SET NULL,
  resolved_product_id uuid REFERENCES public.products (id) ON DELETE SET NULL,
  generator_version text NOT NULL,
  source_run_id uuid,
  upload_id uuid REFERENCES public.raw_report_uploads (id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  generated_by text NOT NULL DEFAULT 'dry_run_or_generator',
  blocker_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_action text,
  candidate_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  lifecycle_status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  archived_at timestamptz,
  CONSTRAINT claim_candidate_drafts_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT claim_candidate_drafts_lifecycle_status_chk CHECK (lifecycle_status IN (
    'draft',
    'blocked',
    'needs_evidence',
    'needs_product_link',
    'ready_for_review',
    'approved_for_candidate',
    'rejected',
    'promoted_to_claim_candidates',
    'archived'
  )),
  CONSTRAINT claim_candidate_drafts_evidence_status_chk CHECK (evidence_status IN (
    'missing',
    'partial',
    'complete',
    'unknown'
  )),
  CONSTRAINT claim_candidate_drafts_confidence_score_chk CHECK (
    confidence_score IS NULL
    OR (confidence_score >= 0 AND confidence_score <= 1)
  )
);

COMMENT ON TABLE public.claim_candidate_drafts IS
  'V2 claim candidate staging; promotes to claim_candidates only via explicit workflow. Legacy claim_candidates remain unchanged.';

-- -----------------------------------------------------------------------------
-- Indexes (non-unique + unique idempotency)
-- -----------------------------------------------------------------------------
CREATE INDEX idx_claim_candidate_drafts_org_store_lifecycle
  ON public.claim_candidate_drafts (organization_id, store_id, lifecycle_status);

CREATE INDEX idx_claim_candidate_drafts_org_source
  ON public.claim_candidate_drafts (organization_id, source_table, source_row_id);

CREATE INDEX idx_claim_candidate_drafts_org_family_reason
  ON public.claim_candidate_drafts (organization_id, claim_family, claim_reason);

-- -----------------------------------------------------------------------------
-- updated_at trigger (reuse repo-wide helper)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_candidate_drafts_set_updated_at ON public.claim_candidate_drafts;
CREATE TRIGGER trg_claim_candidate_drafts_set_updated_at
  BEFORE UPDATE ON public.claim_candidate_drafts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE public.claim_candidate_drafts ENABLE ROW LEVEL SECURITY;

-- Service role: explicit bypass policy (documents intent; service_role also bypasses RLS in Supabase).
DROP POLICY IF EXISTS "claim_candidate_drafts_service_role_all" ON public.claim_candidate_drafts;
CREATE POLICY "claim_candidate_drafts_service_role_all"
  ON public.claim_candidate_drafts
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated: read own org only (INSERT/UPDATE via server/service_role until UI is defined).
DROP POLICY IF EXISTS "claim_candidate_drafts_select_own_org" ON public.claim_candidate_drafts;
CREATE POLICY "claim_candidate_drafts_select_own_org"
  ON public.claim_candidate_drafts
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

-- -----------------------------------------------------------------------------
-- Grants (PostgREST / server clients)
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_candidate_drafts TO service_role;
GRANT SELECT ON public.claim_candidate_drafts TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
