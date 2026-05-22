-- =============================================================================
-- NEXT-CLAIM-CANONICAL-05 — Claim review workflow foundation (no auto-submit).
-- One work item per draft (V2); assignment / SLA / quarantine / AI hooks as data.
-- Apply when approved (supabase db push / migration up / SQL editor).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Work items (queue row; human review authoritative; no marketplace submit)
-- -----------------------------------------------------------------------------
CREATE TABLE public.claim_review_work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,
  target_kind text NOT NULL DEFAULT 'claim_candidate_draft',
  draft_id uuid NOT NULL REFERENCES public.claim_candidate_drafts (id) ON DELETE CASCADE,
  workflow_state text NOT NULL DEFAULT 'pending_assignment',
  review_queue text NOT NULL DEFAULT 'standard',
  priority text NOT NULL DEFAULT 'p2',
  assigned_to uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  assigned_at timestamptz,
  sla_due_at timestamptz,
  follow_up_interval_hours integer,
  next_follow_up_at timestamptz,
  recurring_series_id uuid,
  escalation_level integer NOT NULL DEFAULT 0,
  quarantine_reason text,
  ai_classification jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_confidence numeric(6,4),
  ai_model_version text,
  human_override_at timestamptz,
  human_override_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  billing_meter_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_review_work_items_draft_unique UNIQUE (draft_id),
  CONSTRAINT claim_review_work_items_target_kind_chk CHECK (target_kind IN ('claim_candidate_draft')),
  CONSTRAINT claim_review_work_items_workflow_state_chk CHECK (workflow_state IN (
    'pending_assignment',
    'assigned',
    'in_review',
    'escalated',
    'quarantined_ambiguous',
    'completed',
    'cancelled'
  )),
  CONSTRAINT claim_review_work_items_review_queue_chk CHECK (review_queue IN (
    'standard',
    'priority',
    'quarantine_ambiguity',
    'escalation',
    'follow_up'
  )),
  CONSTRAINT claim_review_work_items_priority_chk CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
  CONSTRAINT claim_review_work_items_escalation_level_chk CHECK (escalation_level >= 0 AND escalation_level <= 5),
  CONSTRAINT claim_review_work_items_ai_confidence_chk CHECK (
    ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)
  ),
  CONSTRAINT claim_review_work_items_follow_up_interval_chk CHECK (
    follow_up_interval_hours IS NULL OR follow_up_interval_hours > 0
  )
);

COMMENT ON TABLE public.claim_review_work_items IS
  'NEXT-CLAIM-CANONICAL-05: human-in-the-loop review queue row for claim_candidate_drafts; no automated marketplace submission.';

CREATE INDEX idx_claim_review_work_items_org_store_state
  ON public.claim_review_work_items (organization_id, store_id, workflow_state);

CREATE INDEX idx_claim_review_work_items_org_sla_due
  ON public.claim_review_work_items (organization_id, sla_due_at)
  WHERE sla_due_at IS NOT NULL;

CREATE INDEX idx_claim_review_work_items_org_next_follow_up
  ON public.claim_review_work_items (organization_id, next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL;

CREATE INDEX idx_claim_review_work_items_assigned_to
  ON public.claim_review_work_items (assigned_to)
  WHERE assigned_to IS NOT NULL;

DROP TRIGGER IF EXISTS trg_claim_review_work_items_set_updated_at ON public.claim_review_work_items;
CREATE TRIGGER trg_claim_review_work_items_set_updated_at
  BEFORE UPDATE ON public.claim_review_work_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Audit events (append-only; server writes via service_role initially)
-- -----------------------------------------------------------------------------
CREATE TABLE public.claim_review_work_item_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES public.claim_review_work_items (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_review_work_item_events_type_chk CHECK (event_type IN (
    'created',
    'assigned',
    'unassigned',
    'state_changed',
    'priority_changed',
    'sla_reset',
    'follow_up_scheduled',
    'quarantined',
    'escalated',
    'human_override',
    'ai_suggestion_recorded',
    'completed',
    'cancelled'
  ))
);

COMMENT ON TABLE public.claim_review_work_item_events IS
  'Append-only audit trail for claim review work items; no automated claim execution.';

CREATE INDEX idx_claim_review_work_item_events_org_created
  ON public.claim_review_work_item_events (organization_id, created_at DESC);

CREATE INDEX idx_claim_review_work_item_events_work_item
  ON public.claim_review_work_item_events (work_item_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE public.claim_review_work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_review_work_item_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claim_review_work_items_service_role_all" ON public.claim_review_work_items;
CREATE POLICY "claim_review_work_items_service_role_all"
  ON public.claim_review_work_items
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "claim_review_work_items_select_own_org" ON public.claim_review_work_items;
CREATE POLICY "claim_review_work_items_select_own_org"
  ON public.claim_review_work_items
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "claim_review_work_item_events_service_role_all" ON public.claim_review_work_item_events;
CREATE POLICY "claim_review_work_item_events_service_role_all"
  ON public.claim_review_work_item_events
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "claim_review_work_item_events_select_own_org" ON public.claim_review_work_item_events;
CREATE POLICY "claim_review_work_item_events_select_own_org"
  ON public.claim_review_work_item_events
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_review_work_items TO service_role;
GRANT SELECT ON public.claim_review_work_items TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_review_work_item_events TO service_role;
GRANT SELECT ON public.claim_review_work_item_events TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
