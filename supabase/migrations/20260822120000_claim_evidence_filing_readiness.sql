-- =============================================================================
-- CLAIM-EVIDENCE-08 — Bulk review audit + draft warning acknowledgment
-- Does not enable claim submission; operator gate metadata only.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.claim_reference_edge_bulk_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES public.claim_candidate_drafts (id) ON DELETE CASCADE,
  generation_id uuid REFERENCES public.claim_enrichment_generations (id) ON DELETE SET NULL,
  scope text NOT NULL,
  group_key text,
  target_status text NOT NULL,
  edges_updated integer NOT NULL DEFAULT 0,
  reviewed_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_reference_edge_bulk_review_scope_chk CHECK (scope IN ('all', 'group')),
  CONSTRAINT claim_reference_edge_bulk_review_status_chk CHECK (
    target_status IN ('accepted', 'rejected', 'needs_review')
  )
);

COMMENT ON TABLE public.claim_reference_edge_bulk_review_events IS
  'CLAIM-EVIDENCE-08: audit header for bulk operator review on persisted edges.';

CREATE INDEX IF NOT EXISTS idx_claim_reference_edge_bulk_review_org_draft_created
  ON public.claim_reference_edge_bulk_review_events (organization_id, draft_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.claim_evidence_draft_operator_state (
  draft_id uuid PRIMARY KEY REFERENCES public.claim_candidate_drafts (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  warnings_acknowledged_at timestamptz,
  warnings_acknowledged_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  acknowledged_warning_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.claim_evidence_draft_operator_state IS
  'CLAIM-EVIDENCE-08: per-draft operator acknowledgments for evidence filing readiness gate.';

CREATE INDEX IF NOT EXISTS idx_claim_evidence_draft_operator_state_org
  ON public.claim_evidence_draft_operator_state (organization_id);

DROP TRIGGER IF EXISTS trg_claim_evidence_draft_operator_state_set_updated_at ON public.claim_evidence_draft_operator_state;
CREATE TRIGGER trg_claim_evidence_draft_operator_state_set_updated_at
  BEFORE UPDATE ON public.claim_evidence_draft_operator_state
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.claim_reference_edge_bulk_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_evidence_draft_operator_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claim_reference_edge_bulk_review_events_service_role_all" ON public.claim_reference_edge_bulk_review_events;
CREATE POLICY "claim_reference_edge_bulk_review_events_service_role_all"
  ON public.claim_reference_edge_bulk_review_events
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_reference_edge_bulk_review_events_select_own_org" ON public.claim_reference_edge_bulk_review_events;
CREATE POLICY "claim_reference_edge_bulk_review_events_select_own_org"
  ON public.claim_reference_edge_bulk_review_events
  FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "claim_evidence_draft_operator_state_service_role_all" ON public.claim_evidence_draft_operator_state;
CREATE POLICY "claim_evidence_draft_operator_state_service_role_all"
  ON public.claim_evidence_draft_operator_state
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_evidence_draft_operator_state_select_own_org" ON public.claim_evidence_draft_operator_state;
CREATE POLICY "claim_evidence_draft_operator_state_select_own_org"
  ON public.claim_evidence_draft_operator_state
  FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

GRANT SELECT, INSERT ON public.claim_reference_edge_bulk_review_events TO service_role;
GRANT SELECT ON public.claim_reference_edge_bulk_review_events TO authenticated;

GRANT SELECT, INSERT, UPDATE ON public.claim_evidence_draft_operator_state TO service_role;
GRANT SELECT ON public.claim_evidence_draft_operator_state TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
