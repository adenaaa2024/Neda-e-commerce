-- =============================================================================
-- NEXT-CONTINUOUS-CLAIM-ENRICHMENT-04 — Additive claim enrichment graph tables.
-- Plan: .cursor/audit-reports/next-continuous-claim-enrichment-02/20260515T211000Z-plan/
-- Dependencies: claim_candidate_drafts (20260814120000); optional claim_review_work_items (20260815160000).
-- Apply only on approved dev/staging (e.g. kxsvedvpjldygtdbylsy). No production without explicit approval.
-- New tables only — does not alter claim_candidates, drafts, filing, or products.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- claim_enrichment_generations — materialized enrichment generation header
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.claim_enrichment_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,
  draft_id uuid NOT NULL REFERENCES public.claim_candidate_drafts (id) ON DELETE CASCADE,
  work_item_id uuid REFERENCES public.claim_review_work_items (id) ON DELETE SET NULL,
  source_table text NOT NULL,
  source_row_id text NOT NULL,
  generation_number integer NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  trigger_kind text NOT NULL,
  rules_version text NOT NULL DEFAULT 'cce.v1',
  source_upload_id uuid REFERENCES public.raw_report_uploads (id) ON DELETE SET NULL,
  source_run_id uuid,
  supersedes_generation_id uuid REFERENCES public.claim_enrichment_generations (id) ON DELETE SET NULL,
  evidence_hash text,
  confidence_before numeric(6, 4),
  confidence_after numeric(6, 4),
  diff_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  operator_refresh_state text NOT NULL DEFAULT 'not_required',
  filing_refresh_state text NOT NULL DEFAULT 'not_required',
  computed_at timestamptz,
  reviewed_at timestamptz,
  frozen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_enrichment_generations_draft_generation_key UNIQUE (draft_id, generation_number),
  CONSTRAINT claim_enrichment_generations_org_idempotency_key UNIQUE (organization_id, idempotency_key),
  CONSTRAINT claim_enrichment_generations_status_chk CHECK (status IN (
    'pending',
    'computed',
    'reviewed',
    'superseded',
    'frozen'
  )),
  CONSTRAINT claim_enrichment_generations_trigger_kind_chk CHECK (trigger_kind IN (
    'initial_snapshot',
    'late_import_replay',
    'manual_replay',
    'operator_refresh_probe',
    'filing_refresh_probe'
  )),
  CONSTRAINT claim_enrichment_generations_operator_refresh_chk CHECK (operator_refresh_state IN (
    'not_required',
    'required',
    'acknowledged',
    'resolved'
  )),
  CONSTRAINT claim_enrichment_generations_filing_refresh_chk CHECK (filing_refresh_state IN (
    'not_required',
    'candidate',
    'blocked_by_terminal',
    'ready_for_new_payload'
  )),
  CONSTRAINT claim_enrichment_generations_confidence_before_chk CHECK (
    confidence_before IS NULL OR (confidence_before >= 0 AND confidence_before <= 1)
  ),
  CONSTRAINT claim_enrichment_generations_confidence_after_chk CHECK (
    confidence_after IS NULL OR (confidence_after >= 0 AND confidence_after <= 1)
  )
);

COMMENT ON TABLE public.claim_enrichment_generations IS
  'CCE: one enrichment generation per claim draft snapshot; supersession via supersedes_generation_id.';

CREATE INDEX IF NOT EXISTS idx_claim_enrichment_generations_org_draft_gen
  ON public.claim_enrichment_generations (organization_id, draft_id, generation_number DESC);

CREATE INDEX IF NOT EXISTS idx_claim_enrichment_generations_org_status_created
  ON public.claim_enrichment_generations (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claim_enrichment_generations_org_source_upload
  ON public.claim_enrichment_generations (organization_id, source_upload_id)
  WHERE source_upload_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- claim_evidence_lineage_events — append-only facts per generation
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.claim_evidence_lineage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES public.claim_enrichment_generations (id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES public.claim_candidate_drafts (id) ON DELETE CASCADE,
  source_upload_id uuid REFERENCES public.raw_report_uploads (id) ON DELETE SET NULL,
  source_run_id uuid,
  event_type text NOT NULL,
  producer text NOT NULL,
  source_table text,
  source_row_id text,
  report_kind text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_sha256 text,
  previous_event_hash text,
  event_hash text,
  created_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_evidence_lineage_events_type_chk CHECK (event_type IN (
    'initial_snapshot',
    'source_import_seen',
    'financial_reference_seen',
    'trid_candidate_seen',
    'shipment_evidence_seen',
    'confidence_changed',
    'edge_invalidated',
    'freeze_applied',
    'finances_archive_event_seen'
  )),
  CONSTRAINT claim_evidence_lineage_events_producer_chk CHECK (producer IN (
    'replay_job',
    'operator',
    'resolver_sync',
    'api_probe'
  ))
);

COMMENT ON TABLE public.claim_evidence_lineage_events IS
  'CCE: append-only lineage facts; immutable at app layer (no authenticated UPDATE/DELETE).';

CREATE INDEX IF NOT EXISTS idx_claim_evidence_lineage_events_org_draft_created
  ON public.claim_evidence_lineage_events (organization_id, draft_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claim_evidence_lineage_events_org_generation_created
  ON public.claim_evidence_lineage_events (organization_id, generation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_claim_evidence_lineage_events_org_source_upload
  ON public.claim_evidence_lineage_events (organization_id, source_upload_id)
  WHERE source_upload_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_evidence_lineage_events_org_gen_payload_hash
  ON public.claim_evidence_lineage_events (organization_id, generation_id, payload_sha256)
  WHERE payload_sha256 IS NOT NULL;

-- -----------------------------------------------------------------------------
-- claim_reference_edges — typed evidence graph edges
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.claim_reference_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  generation_id uuid NOT NULL REFERENCES public.claim_enrichment_generations (id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES public.claim_candidate_drafts (id) ON DELETE CASCADE,
  edge_type text NOT NULL,
  from_node_kind text NOT NULL,
  from_source_table text,
  from_source_row_id text,
  to_node_kind text NOT NULL,
  to_source_table text,
  to_source_row_id text,
  reference_kind text,
  reference_value text,
  confidence_score numeric(6, 4),
  ambiguity_group_key text,
  ambiguity_rank integer,
  edge_reason text,
  evidence_event_id uuid REFERENCES public.claim_evidence_lineage_events (id) ON DELETE SET NULL,
  supersedes_edge_id uuid REFERENCES public.claim_reference_edges (id) ON DELETE SET NULL,
  invalidated_by_edge_id uuid REFERENCES public.claim_reference_edges (id) ON DELETE SET NULL,
  source_citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_reference_edges_edge_type_chk CHECK (edge_type IN (
    'operational_to_financial',
    'claim_to_trid',
    'claim_to_settlement',
    'claim_to_reimbursement',
    'claim_to_removal',
    'claim_to_shipment',
    'operational_to_slip_line',
    'slip_line_to_product'
  )),
  CONSTRAINT claim_reference_edges_confidence_chk CHECK (
    confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)
  )
);

COMMENT ON TABLE public.claim_reference_edges IS
  'CCE: typed reference edges for claim evidence graph; parallel ambiguous candidates preserved.';

CREATE INDEX IF NOT EXISTS idx_claim_reference_edges_org_draft_generation
  ON public.claim_reference_edges (organization_id, draft_id, generation_id);

CREATE INDEX IF NOT EXISTS idx_claim_reference_edges_org_type_created
  ON public.claim_reference_edges (organization_id, edge_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claim_reference_edges_org_ambiguity_group
  ON public.claim_reference_edges (organization_id, ambiguity_group_key)
  WHERE ambiguity_group_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claim_reference_edges_org_reference
  ON public.claim_reference_edges (organization_id, reference_kind, reference_value)
  WHERE reference_value IS NOT NULL;

-- -----------------------------------------------------------------------------
-- claim_enrichment_freeze_state — optional freeze governance cache
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.claim_enrichment_freeze_state (
  draft_id uuid PRIMARY KEY REFERENCES public.claim_candidate_drafts (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  freeze_state text NOT NULL DEFAULT 'open',
  freeze_reason text,
  latest_allowed_generation_id uuid REFERENCES public.claim_enrichment_generations (id) ON DELETE SET NULL,
  terminal_source_kind text,
  terminal_source_id uuid,
  frozen_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  frozen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_enrichment_freeze_state_freeze_chk CHECK (freeze_state IN (
    'open',
    'soft_frozen',
    'hard_frozen'
  )),
  CONSTRAINT claim_enrichment_freeze_state_reason_chk CHECK (freeze_reason IS NULL OR freeze_reason IN (
    'work_item_completed',
    'filing_terminal_success',
    'manual_legal_hold',
    'archived'
  ))
);

COMMENT ON TABLE public.claim_enrichment_freeze_state IS
  'CCE: per-draft freeze cache; derived policy may also read work_item/filing terminal state.';

CREATE INDEX IF NOT EXISTS idx_claim_enrichment_freeze_state_org
  ON public.claim_enrichment_freeze_state (organization_id, freeze_state);

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_claim_enrichment_generations_set_updated_at ON public.claim_enrichment_generations;
CREATE TRIGGER trg_claim_enrichment_generations_set_updated_at
  BEFORE UPDATE ON public.claim_enrichment_generations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_claim_enrichment_freeze_state_set_updated_at ON public.claim_enrichment_freeze_state;
CREATE TRIGGER trg_claim_enrichment_freeze_state_set_updated_at
  BEFORE UPDATE ON public.claim_enrichment_freeze_state
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE public.claim_enrichment_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_evidence_lineage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_reference_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_enrichment_freeze_state ENABLE ROW LEVEL SECURITY;

-- generations
DROP POLICY IF EXISTS "claim_enrichment_generations_service_role_all" ON public.claim_enrichment_generations;
CREATE POLICY "claim_enrichment_generations_service_role_all"
  ON public.claim_enrichment_generations
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_enrichment_generations_select_own_org" ON public.claim_enrichment_generations;
CREATE POLICY "claim_enrichment_generations_select_own_org"
  ON public.claim_enrichment_generations
  FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

-- lineage events (append-only for clients)
DROP POLICY IF EXISTS "claim_evidence_lineage_events_service_role_all" ON public.claim_evidence_lineage_events;
CREATE POLICY "claim_evidence_lineage_events_service_role_all"
  ON public.claim_evidence_lineage_events
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_evidence_lineage_events_select_own_org" ON public.claim_evidence_lineage_events;
CREATE POLICY "claim_evidence_lineage_events_select_own_org"
  ON public.claim_evidence_lineage_events
  FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

-- reference edges
DROP POLICY IF EXISTS "claim_reference_edges_service_role_all" ON public.claim_reference_edges;
CREATE POLICY "claim_reference_edges_service_role_all"
  ON public.claim_reference_edges
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_reference_edges_select_own_org" ON public.claim_reference_edges;
CREATE POLICY "claim_reference_edges_select_own_org"
  ON public.claim_reference_edges
  FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

-- freeze state
DROP POLICY IF EXISTS "claim_enrichment_freeze_state_service_role_all" ON public.claim_enrichment_freeze_state;
CREATE POLICY "claim_enrichment_freeze_state_service_role_all"
  ON public.claim_enrichment_freeze_state
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_enrichment_freeze_state_select_own_org" ON public.claim_enrichment_freeze_state;
CREATE POLICY "claim_enrichment_freeze_state_select_own_org"
  ON public.claim_enrichment_freeze_state
  FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_enrichment_generations TO service_role;
GRANT SELECT ON public.claim_enrichment_generations TO authenticated;

GRANT SELECT, INSERT ON public.claim_evidence_lineage_events TO service_role;
GRANT SELECT ON public.claim_evidence_lineage_events TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_reference_edges TO service_role;
GRANT SELECT ON public.claim_reference_edges TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_enrichment_freeze_state TO service_role;
GRANT SELECT ON public.claim_enrichment_freeze_state TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
