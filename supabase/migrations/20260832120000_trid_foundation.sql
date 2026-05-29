-- =============================================================================
-- TRID FOUNDATION — additive trid_entities / trid_links / trid_events (DRAFT)
-- Prerequisite: public.claim_lines (20260831120000_claim_lines_foundation.sql)
-- Financial layer: REUSE financial_reference_resolver.trid_key — no duplicate FRR tables.
-- Apply only when APPROVED_TRID_FOUNDATION_MIGRATION=true on staging.
-- =============================================================================

BEGIN;

-- ── trid_entities: operational discrepancy anchor (1:1 claim_line at operational grain) ──
CREATE TABLE IF NOT EXISTS public.trid_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  entity_layer text NOT NULL DEFAULT 'operational',
  status text NOT NULL DEFAULT 'detected',

  claim_line_id uuid NOT NULL REFERENCES public.claim_lines (id) ON DELETE CASCADE,

  -- Operator-selected financial key from FRR (not a separate financial TRID table)
  selected_financial_trid_key text,
  selected_frr_source_table text,
  selected_frr_source_row_id text,

  -- Filing bundle (many claim_lines may reference same filing request via links / entity updates)
  claim_filing_request_id uuid REFERENCES public.claim_filing_requests (id) ON DELETE SET NULL,

  primary_product_id uuid REFERENCES public.products (id) ON DELETE SET NULL,
  primary_order_id text,
  primary_sku text,

  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trid_entities_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT trid_entities_claim_line_id_key UNIQUE (claim_line_id),
  CONSTRAINT trid_entities_entity_layer_chk CHECK (entity_layer IN (
    'operational',
    'filing_bundle'
  )),
  CONSTRAINT trid_entities_status_chk CHECK (status IN (
    'detected',
    'evidence_needed',
    'claim_ready',
    'submitted',
    'reimbursed',
    'rejected',
    'closed'
  )),
  CONSTRAINT trid_entities_frr_selection_chk CHECK (
    selected_financial_trid_key IS NULL
    OR (selected_frr_source_table IS NOT NULL AND selected_frr_source_row_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.trid_entities IS
  'Operational TRID entity: one discrepancy / claim_line. Financial keys reference FRR.trid_key; filing groups via claim_filing_request_id + trid_links.';

COMMENT ON COLUMN public.trid_entities.selected_financial_trid_key IS
  'Reuse financial_reference_resolver.trid_key — do not duplicate financial resolver rows.';

CREATE INDEX idx_trid_entities_org_store_status
  ON public.trid_entities (organization_id, store_id, status);

CREATE INDEX idx_trid_entities_org_filing
  ON public.trid_entities (organization_id, claim_filing_request_id)
  WHERE claim_filing_request_id IS NOT NULL;

CREATE INDEX idx_trid_entities_selected_trid_key
  ON public.trid_entities (organization_id, selected_financial_trid_key)
  WHERE selected_financial_trid_key IS NOT NULL;

-- ── trid_links: polymorphic evidence / spine edges (complements claim_reference_edges) ──
CREATE TABLE IF NOT EXISTS public.trid_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  trid_entity_id uuid NOT NULL REFERENCES public.trid_entities (id) ON DELETE CASCADE,

  link_role text NOT NULL,
  target_kind text NOT NULL,
  target_id uuid,
  target_trid_key text,
  target_source_table text,
  target_source_row_id text,

  confidence numeric(10, 4),
  source_table text,
  source_row_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trid_links_link_role_chk CHECK (link_role IN (
    'operational_source',
    'financial_match',
    'evidence',
    'filing',
    'product_spine'
  )),
  CONSTRAINT trid_links_target_kind_chk CHECK (target_kind IN (
    'claim_lines',
    'return_items',
    'expected_packages',
    'products',
    'claim_filing_requests',
    'financial_reference_resolver',
    'claim_reference_edges',
    'claim_candidate_drafts',
    'packages',
    'slip_contents'
  )),
  CONSTRAINT trid_links_target_ref_chk CHECK (
    target_id IS NOT NULL
    OR target_trid_key IS NOT NULL
    OR (target_source_table IS NOT NULL AND target_source_row_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.trid_links IS
  'Edges from trid_entity to operational/financial/filing targets. FRR links use target_trid_key + source pointer — no financial TRID duplicate table.';

CREATE INDEX idx_trid_links_entity
  ON public.trid_links (trid_entity_id);

CREATE INDEX idx_trid_links_org_target_kind_id
  ON public.trid_links (organization_id, target_kind, target_id)
  WHERE target_id IS NOT NULL;

CREATE INDEX idx_trid_links_org_frr_trid_key
  ON public.trid_links (organization_id, target_trid_key)
  WHERE target_kind = 'financial_reference_resolver' AND target_trid_key IS NOT NULL;

CREATE UNIQUE INDEX uq_trid_links_entity_role_target
  ON public.trid_links (
    trid_entity_id,
    link_role,
    target_kind,
    COALESCE(target_id::text, ''),
    COALESCE(target_trid_key, ''),
    COALESCE(target_source_table, ''),
    COALESCE(target_source_row_id, '')
  );

-- ── trid_events: append-only lifecycle audit ──
CREATE TABLE IF NOT EXISTS public.trid_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  trid_entity_id uuid NOT NULL REFERENCES public.trid_entities (id) ON DELETE CASCADE,

  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  actor_kind text NOT NULL DEFAULT 'system',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trid_events_actor_kind_chk CHECK (actor_kind IN ('system', 'operator', 'agent')),
  CONSTRAINT trid_events_from_status_chk CHECK (
    from_status IS NULL OR from_status IN (
      'detected', 'evidence_needed', 'claim_ready', 'submitted', 'reimbursed', 'rejected', 'closed'
    )
  ),
  CONSTRAINT trid_events_to_status_chk CHECK (
    to_status IS NULL OR to_status IN (
      'detected', 'evidence_needed', 'claim_ready', 'submitted', 'reimbursed', 'rejected', 'closed'
    )
  )
);

COMMENT ON TABLE public.trid_events IS
  'Append-only TRID lifecycle audit; mirrors claim_evidence_lineage_events pattern for entity status transitions.';

CREATE INDEX idx_trid_events_entity_created
  ON public.trid_events (trid_entity_id, created_at DESC);

CREATE INDEX idx_trid_events_org_type
  ON public.trid_events (organization_id, event_type);

-- ── updated_at trigger (reuse set_updated_at if present) ──
DROP TRIGGER IF EXISTS trg_trid_entities_set_updated_at ON public.trid_entities;
CREATE TRIGGER trg_trid_entities_set_updated_at
  BEFORE UPDATE ON public.trid_entities
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ──
ALTER TABLE public.trid_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trid_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trid_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trid_entities_service_role_all" ON public.trid_entities;
CREATE POLICY "trid_entities_service_role_all"
  ON public.trid_entities AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "trid_entities_select_own_org" ON public.trid_entities;
CREATE POLICY "trid_entities_select_own_org"
  ON public.trid_entities FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "trid_links_service_role_all" ON public.trid_links;
CREATE POLICY "trid_links_service_role_all"
  ON public.trid_links AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "trid_links_select_own_org" ON public.trid_links;
CREATE POLICY "trid_links_select_own_org"
  ON public.trid_links FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "trid_events_service_role_all" ON public.trid_events;
CREATE POLICY "trid_events_service_role_all"
  ON public.trid_events AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "trid_events_select_own_org" ON public.trid_events;
CREATE POLICY "trid_events_select_own_org"
  ON public.trid_events FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trid_entities TO service_role;
GRANT SELECT ON public.trid_entities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trid_links TO service_role;
GRANT SELECT ON public.trid_links TO authenticated;
GRANT SELECT, INSERT ON public.trid_events TO service_role;
GRANT SELECT ON public.trid_events TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
