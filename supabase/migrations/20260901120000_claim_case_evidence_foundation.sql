-- =============================================================================
-- CLAIM-CASE-EVIDENCE-FOUNDATION — additive case/evidence/routing/SLA (DRAFT — do not apply)
-- Prerequisite: public.claim_lines (20260831120000)
-- Dry-run: claim-case-evidence-foundation-schema-dryrun
-- =============================================================================

BEGIN;

-- ── claim_cases ──
CREATE TABLE IF NOT EXISTS public.claim_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  case_number text,
  claim_source text NOT NULL,
  claim_subtype text,
  scanner_issue_type text,
  status text NOT NULL DEFAULT 'open',
  status_reason text,
  priority text NOT NULL DEFAULT 'normal',

  routed_company_key text,
  routed_company_display_name text,

  sla_rule_id uuid,
  sla_due_at timestamptz,
  sla_breached_at timestamptz,

  claim_filing_request_id uuid REFERENCES public.claim_filing_requests (id) ON DELETE SET NULL,

  primary_return_item_id uuid REFERENCES public.return_items (id) ON DELETE SET NULL,
  primary_package_id uuid REFERENCES public.packages (id) ON DELETE SET NULL,
  primary_claim_line_id uuid REFERENCES public.claim_lines (id) ON DELETE SET NULL,
  primary_tracking_number text,
  primary_order_id text,
  primary_sku text,
  primary_resolved_product_id uuid REFERENCES public.products (id) ON DELETE SET NULL,

  opened_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,

  CONSTRAINT claim_cases_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT claim_cases_claim_source_chk CHECK (claim_source IN (
    'scanner_operator_issue',
    'expected_mismatch',
    'shipment_discrepancy',
    'delayed_not_received',
    'amazon_reimbursement',
    'warehouse_qc_issue'
  )),
  CONSTRAINT claim_cases_scanner_issue_type_chk CHECK (
    scanner_issue_type IS NULL OR scanner_issue_type IN ('damaged_product', 'scratched', 'expired', 'missing_parts', 'wrong_item', 'empty_box', 'damaged_box', 'wet', 'counterfeit_suspect', 'operator_other')
  ),
  CONSTRAINT claim_cases_status_chk CHECK (status IN (
    'open',
    'investigating',
    'waiting_amazon',
    'reimbursed',
    'rejected',
    'closed'
  )),
  CONSTRAINT claim_cases_priority_chk CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
);

COMMENT ON TABLE public.claim_cases IS
  'Operator claim case: workflow container for claim_lines + claim_evidence. Scanner issues use scanner_issue_type + claim_source=scanner_operator_issue.';

COMMENT ON COLUMN public.claim_cases.scanner_issue_type IS
  'Canonical scanner defect tag when claim_source=scanner_operator_issue; mirrors return_items.conditions / item-unit modal.';

CREATE INDEX idx_claim_cases_org_store_status
  ON public.claim_cases (organization_id, store_id, status);

CREATE INDEX idx_claim_cases_org_scanner_issue
  ON public.claim_cases (organization_id, scanner_issue_type)
  WHERE scanner_issue_type IS NOT NULL;

-- ── claim_lines: case FK + scanner issue on item-grain lines ──
ALTER TABLE public.claim_lines
  ADD COLUMN IF NOT EXISTS claim_case_id uuid REFERENCES public.claim_cases (id) ON DELETE SET NULL;

ALTER TABLE public.claim_lines
  ADD COLUMN IF NOT EXISTS scanner_issue_type text;

ALTER TABLE public.claim_lines
  DROP CONSTRAINT IF EXISTS claim_lines_scanner_issue_type_chk;

ALTER TABLE public.claim_lines
  ADD CONSTRAINT claim_lines_scanner_issue_type_chk CHECK (
    scanner_issue_type IS NULL OR scanner_issue_type IN ('damaged_product', 'scratched', 'expired', 'missing_parts', 'wrong_item', 'empty_box', 'damaged_box', 'wet', 'counterfeit_suspect', 'operator_other')
  );

CREATE INDEX IF NOT EXISTS idx_claim_lines_claim_case
  ON public.claim_lines (claim_case_id)
  WHERE claim_case_id IS NOT NULL;

-- ── claim_evidence ──
CREATE TABLE IF NOT EXISTS public.claim_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  claim_case_id uuid NOT NULL REFERENCES public.claim_cases (id) ON DELETE CASCADE,
  claim_line_id uuid REFERENCES public.claim_lines (id) ON DELETE SET NULL,

  evidence_kind text NOT NULL,
  capture_source text NOT NULL DEFAULT 'operator',
  scanner_issue_type text,

  storage_bucket text,
  storage_path text,
  public_url text,
  mime_type text,
  byte_size bigint,
  sha256 text,

  operator_note text,
  scanner_session_id text,
  return_item_id uuid REFERENCES public.return_items (id) ON DELETE SET NULL,
  package_id uuid REFERENCES public.packages (id) ON DELETE SET NULL,
  pallet_id uuid REFERENCES public.pallets (id) ON DELETE SET NULL,
  slip_content_id uuid REFERENCES public.slip_contents (id) ON DELETE SET NULL,
  expected_package_id uuid REFERENCES public.expected_packages (id) ON DELETE SET NULL,
  product_id uuid REFERENCES public.products (id) ON DELETE SET NULL,

  captured_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT claim_evidence_kind_chk CHECK (evidence_kind IN (
    'photo',
    'operator_note',
    'scanner_ref',
    'slip_ref',
    'expected_ref',
    'package_ref',
    'product_ref',
    'document',
    'system_snapshot'
  )),
  CONSTRAINT claim_evidence_capture_source_chk CHECK (capture_source IN (
    'operator',
    'scanner',
    'import',
    'enrichment',
    'amazon_api'
  )),
  CONSTRAINT claim_evidence_scanner_issue_type_chk CHECK (
    scanner_issue_type IS NULL OR scanner_issue_type IN ('damaged_product', 'scratched', 'expired', 'missing_parts', 'wrong_item', 'empty_box', 'damaged_box', 'wet', 'counterfeit_suspect', 'operator_other')
  ),
  CONSTRAINT claim_evidence_media_chk CHECK (
    (evidence_kind IN ('photo', 'document') AND (storage_path IS NOT NULL OR public_url IS NOT NULL))
    OR evidence_kind NOT IN ('photo', 'document')
  )
);

COMMENT ON TABLE public.claim_evidence IS
  'Case evidence: photos, operator notes, scanner/slip/package/product refs. Photos from scanner attach here + optional legacy URL on return_items during transition.';

CREATE INDEX idx_claim_evidence_case_captured
  ON public.claim_evidence (claim_case_id, captured_at DESC);

CREATE INDEX idx_claim_evidence_return_item
  ON public.claim_evidence (return_item_id)
  WHERE return_item_id IS NOT NULL;

-- ── claim_company_routing_rules ──
CREATE TABLE IF NOT EXISTS public.claim_company_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  claim_source text NOT NULL,
  claim_subtype text,
  scanner_issue_type text,
  routed_company_key text NOT NULL,
  routed_company_display_name text,
  marketplace text,
  is_active boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  rule_version text NOT NULL DEFAULT 'ccr.v1',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT claim_company_routing_rules_source_chk CHECK (claim_source IN (
    'scanner_operator_issue',
    'expected_mismatch',
    'shipment_discrepancy',
    'delayed_not_received',
    'amazon_reimbursement',
    'warehouse_qc_issue'
  )),
  CONSTRAINT claim_company_routing_rules_scanner_issue_chk CHECK (
    scanner_issue_type IS NULL OR scanner_issue_type IN ('damaged_product', 'scratched', 'expired', 'missing_parts', 'wrong_item', 'empty_box', 'damaged_box', 'wet', 'counterfeit_suspect', 'operator_other')
  )
);

CREATE UNIQUE INDEX uq_claim_company_routing_active
  ON public.claim_company_routing_rules (
    organization_id,
    COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid),
    claim_source,
    COALESCE(claim_subtype, ''),
    COALESCE(scanner_issue_type, ''),
    routed_company_key
  )
  WHERE is_active = true;

-- ── claim_sla_rules (settings-driven thresholds; org_settings fallback) ──
CREATE TABLE IF NOT EXISTS public.claim_sla_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  rule_key text NOT NULL,
  claim_source text NOT NULL,
  trigger_kind text NOT NULL,
  threshold_days integer,
  threshold_hours integer,
  business_calendar text NOT NULL DEFAULT 'calendar',
  escalates_to_status text,
  settings_path text,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT claim_sla_rules_trigger_chk CHECK (trigger_kind IN (
    'days_since_shipment',
    'days_since_expected_receive',
    'days_since_last_scan',
    'days_in_status'
  )),
  CONSTRAINT claim_sla_rules_source_chk CHECK (claim_source IN (
    'scanner_operator_issue',
    'expected_mismatch',
    'shipment_discrepancy',
    'delayed_not_received',
    'amazon_reimbursement',
    'warehouse_qc_issue'
  ))
);

COMMENT ON COLUMN public.claim_sla_rules.settings_path IS
  'JSON path into organization_settings.metadata or default_claim_evidence for threshold override, e.g. delayed_not_received_days.';

CREATE UNIQUE INDEX uq_claim_sla_rules_org_key
  ON public.claim_sla_rules (organization_id, COALESCE(store_id, '00000000-0000-0000-0000-000000000000'::uuid), rule_key)
  WHERE is_active = true;

-- ── claim_case_events (append-only) ──
CREATE TABLE IF NOT EXISTS public.claim_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  claim_case_id uuid NOT NULL REFERENCES public.claim_cases (id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT claim_case_events_type_chk CHECK (event_type IN (
    'case_opened',
    'status_changed',
    'assigned',
    'evidence_added',
    'sla_breached',
    'escalated',
    'trid_linked',
    'case_closed'
  ))
);

CREATE INDEX idx_claim_case_events_case_created
  ON public.claim_case_events (claim_case_id, created_at ASC);

-- FK claim_cases.sla_rule_id after claim_sla_rules exists
ALTER TABLE public.claim_cases
  DROP CONSTRAINT IF EXISTS claim_cases_sla_rule_id_fkey;

ALTER TABLE public.claim_cases
  ADD CONSTRAINT claim_cases_sla_rule_id_fkey
  FOREIGN KEY (sla_rule_id) REFERENCES public.claim_sla_rules (id) ON DELETE SET NULL;

-- ── RLS + permissions (catalog enforced in app; policies mirror claim_lines) ──
ALTER TABLE public.claim_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_company_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_sla_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_case_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claim_cases_service_role_all" ON public.claim_cases;
CREATE POLICY "claim_cases_service_role_all"
  ON public.claim_cases FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_cases_select_own_org" ON public.claim_cases;
CREATE POLICY "claim_cases_select_own_org"
  ON public.claim_cases FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "claim_evidence_service_role_all" ON public.claim_evidence;
CREATE POLICY "claim_evidence_service_role_all"
  ON public.claim_evidence FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_evidence_select_own_org" ON public.claim_evidence;
CREATE POLICY "claim_evidence_select_own_org"
  ON public.claim_evidence FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "claim_company_routing_rules_service_role_all" ON public.claim_company_routing_rules;
CREATE POLICY "claim_company_routing_rules_service_role_all"
  ON public.claim_company_routing_rules FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_company_routing_rules_select_own_org" ON public.claim_company_routing_rules;
CREATE POLICY "claim_company_routing_rules_select_own_org"
  ON public.claim_company_routing_rules FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "claim_sla_rules_service_role_all" ON public.claim_sla_rules;
CREATE POLICY "claim_sla_rules_service_role_all"
  ON public.claim_sla_rules FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_sla_rules_select_own_org" ON public.claim_sla_rules;
CREATE POLICY "claim_sla_rules_select_own_org"
  ON public.claim_sla_rules FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "claim_case_events_service_role_all" ON public.claim_case_events;
CREATE POLICY "claim_case_events_service_role_all"
  ON public.claim_case_events FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_case_events_select_own_org" ON public.claim_case_events;
CREATE POLICY "claim_case_events_select_own_org"
  ON public.claim_case_events FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_cases TO service_role;
GRANT SELECT ON public.claim_cases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_evidence TO service_role;
GRANT SELECT ON public.claim_evidence TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_company_routing_rules TO service_role;
GRANT SELECT ON public.claim_company_routing_rules TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_sla_rules TO service_role;
GRANT SELECT ON public.claim_sla_rules TO authenticated;
GRANT SELECT, INSERT ON public.claim_case_events TO service_role;
GRANT SELECT ON public.claim_case_events TO authenticated;

COMMIT;
NOTIFY pgrst, 'reload schema';
