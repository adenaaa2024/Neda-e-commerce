-- =============================================================================
-- PHASE-7H — Re-anchor claim_reference_edges to the unified claim_candidates pool.
--
-- * Adds nullable candidate_id (new pool anchor). draft_id/generation_id become
--   nullable so candidate-anchored edges need no draft; legacy draft edges keep
--   their values and stay readable (drafts are NOT pool truth).
-- * Extends edge_type with the 7H spine vocabulary:
--   corroborates / resolves / supersedes / duplicates / source_evidence /
--   financial_reference.
-- * Partial unique index on the candidate-edge natural key prevents duplicate
--   edge explosion on re-materialization.
-- No new tables. Apply only on approved staging.
-- =============================================================================

BEGIN;

ALTER TABLE public.claim_reference_edges
  ALTER COLUMN draft_id DROP NOT NULL,
  ALTER COLUMN generation_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS candidate_id uuid REFERENCES public.claim_candidates (id) ON DELETE CASCADE;

COMMENT ON COLUMN public.claim_reference_edges.candidate_id IS
  'Phase 7H: unified pool anchor. Either candidate_id (pool truth) or draft_id (legacy CCE drafts) must be set.';

ALTER TABLE public.claim_reference_edges
  DROP CONSTRAINT IF EXISTS claim_reference_edges_anchor_chk;

ALTER TABLE public.claim_reference_edges
  ADD CONSTRAINT claim_reference_edges_anchor_chk CHECK (
    candidate_id IS NOT NULL OR draft_id IS NOT NULL
  );

ALTER TABLE public.claim_reference_edges
  DROP CONSTRAINT IF EXISTS claim_reference_edges_edge_type_chk;

ALTER TABLE public.claim_reference_edges
  ADD CONSTRAINT claim_reference_edges_edge_type_chk CHECK (edge_type IN (
    -- legacy CCE draft-era types (kept readable)
    'operational_to_financial',
    'claim_to_trid',
    'claim_to_settlement',
    'claim_to_reimbursement',
    'claim_to_removal',
    'claim_to_shipment',
    'operational_to_slip_line',
    'slip_line_to_product',
    -- 7H unified-pool spine types
    'corroborates',
    'resolves',
    'supersedes',
    'duplicates',
    'source_evidence',
    'financial_reference'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_reference_edges_candidate_natural
  ON public.claim_reference_edges (
    organization_id,
    candidate_id,
    edge_type,
    COALESCE(to_source_table, ''),
    COALESCE(to_source_row_id, ''),
    COALESCE(reference_kind, ''),
    COALESCE(reference_value, '')
  )
  WHERE candidate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claim_reference_edges_org_candidate
  ON public.claim_reference_edges (organization_id, candidate_id)
  WHERE candidate_id IS NOT NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
