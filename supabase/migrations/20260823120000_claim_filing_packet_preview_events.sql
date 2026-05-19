-- =============================================================================
-- CLAIM-EVIDENCE-09 — Filing packet preview view audit (no claim submission)
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.claim_filing_packet_preview_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES public.claim_candidate_drafts (id) ON DELETE CASCADE,
  generation_id uuid REFERENCES public.claim_enrichment_generations (id) ON DELETE SET NULL,
  viewed_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  ready_for_preview boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.claim_filing_packet_preview_events IS
  'CLAIM-EVIDENCE-09: append-only log when operator loads filing packet preview (not submission).';

CREATE INDEX IF NOT EXISTS idx_claim_filing_packet_preview_events_org_draft_created
  ON public.claim_filing_packet_preview_events (organization_id, draft_id, created_at DESC);

ALTER TABLE public.claim_filing_packet_preview_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claim_filing_packet_preview_events_service_role_all" ON public.claim_filing_packet_preview_events;
CREATE POLICY "claim_filing_packet_preview_events_service_role_all"
  ON public.claim_filing_packet_preview_events
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_filing_packet_preview_events_select_own_org" ON public.claim_filing_packet_preview_events;
CREATE POLICY "claim_filing_packet_preview_events_select_own_org"
  ON public.claim_filing_packet_preview_events
  FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

GRANT SELECT, INSERT ON public.claim_filing_packet_preview_events TO service_role;
GRANT SELECT ON public.claim_filing_packet_preview_events TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
