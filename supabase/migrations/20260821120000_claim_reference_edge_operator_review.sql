-- =============================================================================
-- CLAIM-EVIDENCE-07 — Operator review on persisted claim_reference_edges
-- Append-only audit: claim_reference_edge_review_events
-- Does not alter claim filing, FRR, or products.
-- =============================================================================

BEGIN;

ALTER TABLE public.claim_reference_edges
  ADD COLUMN IF NOT EXISTS operator_review_status text NOT NULL DEFAULT 'needs_review',
  ADD COLUMN IF NOT EXISTS operator_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS operator_reviewed_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS operator_review_note text;

ALTER TABLE public.claim_reference_edges
  DROP CONSTRAINT IF EXISTS claim_reference_edges_operator_review_status_chk;

ALTER TABLE public.claim_reference_edges
  ADD CONSTRAINT claim_reference_edges_operator_review_status_chk CHECK (
    operator_review_status IN ('accepted', 'rejected', 'needs_review')
  );

COMMENT ON COLUMN public.claim_reference_edges.operator_review_status IS
  'Operator triage for persisted evidence edge (CLAIM-EVIDENCE-07).';

CREATE INDEX IF NOT EXISTS idx_claim_reference_edges_org_draft_review_status
  ON public.claim_reference_edges (organization_id, draft_id, operator_review_status);

-- -----------------------------------------------------------------------------
-- Append-only audit trail per status change
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.claim_reference_edge_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  edge_id uuid NOT NULL REFERENCES public.claim_reference_edges (id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES public.claim_candidate_drafts (id) ON DELETE CASCADE,
  generation_id uuid REFERENCES public.claim_enrichment_generations (id) ON DELETE SET NULL,
  previous_status text,
  new_status text NOT NULL,
  review_note text,
  reviewed_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_reference_edge_review_events_new_status_chk CHECK (
    new_status IN ('accepted', 'rejected', 'needs_review')
  ),
  CONSTRAINT claim_reference_edge_review_events_prev_status_chk CHECK (
    previous_status IS NULL OR previous_status IN ('accepted', 'rejected', 'needs_review')
  )
);

COMMENT ON TABLE public.claim_reference_edge_review_events IS
  'CLAIM-EVIDENCE-07: append-only operator review audit for claim_reference_edges.';

CREATE INDEX IF NOT EXISTS idx_claim_reference_edge_review_events_org_edge_created
  ON public.claim_reference_edge_review_events (organization_id, edge_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claim_reference_edge_review_events_org_draft_created
  ON public.claim_reference_edge_review_events (organization_id, draft_id, created_at DESC);

ALTER TABLE public.claim_reference_edge_review_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claim_reference_edge_review_events_service_role_all" ON public.claim_reference_edge_review_events;
CREATE POLICY "claim_reference_edge_review_events_service_role_all"
  ON public.claim_reference_edge_review_events
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_reference_edge_review_events_select_own_org" ON public.claim_reference_edge_review_events;
CREATE POLICY "claim_reference_edge_review_events_select_own_org"
  ON public.claim_reference_edge_review_events
  FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

GRANT SELECT, INSERT ON public.claim_reference_edge_review_events TO service_role;
GRANT SELECT ON public.claim_reference_edge_review_events TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
