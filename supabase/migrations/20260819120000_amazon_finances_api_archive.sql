-- =============================================================================
-- NEXT-FINANCES-API-ARCHIVE-02 — Append-only SP-API Finances archive tables
-- Plan: .cursor/audit-reports/next-finances-api-archive-01/20260518T220000Z/
-- No worker, no ingest, no FRR / settlement spine writes.
-- Apply via `supabase db push` / migration up when approved.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- amazon_finances_source_runs — control plane per Finances pull
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.amazon_finances_source_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,
  marketplace_id text,
  finances_api_version text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  window_start timestamptz,
  window_end timestamptz,
  state text NOT NULL,
  attempt jsonb NOT NULL DEFAULT '{}'::jsonb,
  upload_id uuid REFERENCES public.raw_report_uploads (id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amazon_finances_source_runs_state_chk CHECK (
    state = ANY (
      ARRAY[
        'requested'::text,
        'polling'::text,
        'archived'::text,
        'complete'::text,
        'failed'::text
      ]
    )
  ),
  CONSTRAINT amazon_finances_source_runs_org_idempotency_key UNIQUE (organization_id, idempotency_key)
);

COMMENT ON TABLE public.amazon_finances_source_runs IS
  'Control plane for one logical Amazon Finances API pull (window, marketplace, pagination).';

CREATE INDEX IF NOT EXISTS idx_amazon_finances_source_runs_org_state
  ON public.amazon_finances_source_runs (organization_id, state);

CREATE INDEX IF NOT EXISTS idx_amazon_finances_source_runs_org_created
  ON public.amazon_finances_source_runs (organization_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- amazon_finances_api_pages — raw paginated API responses per run
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.amazon_finances_api_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  source_run_id uuid NOT NULL REFERENCES public.amazon_finances_source_runs (id) ON DELETE RESTRICT,
  sequence integer NOT NULL,
  operation text NOT NULL,
  next_token_in text,
  next_token_out text,
  http_status integer NOT NULL,
  response_sha256 text NOT NULL,
  raw_body jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amazon_finances_api_pages_sequence_nonneg_chk CHECK (sequence >= 0),
  CONSTRAINT amazon_finances_api_pages_run_op_sequence_key UNIQUE (source_run_id, operation, sequence)
);

COMMENT ON TABLE public.amazon_finances_api_pages IS
  'Verifiable raw Finances API pages (append-only per source_run_id + operation + sequence).';

CREATE INDEX IF NOT EXISTS idx_amazon_finances_api_pages_source_run
  ON public.amazon_finances_api_pages (source_run_id);

CREATE INDEX IF NOT EXISTS idx_amazon_finances_api_pages_org_captured
  ON public.amazon_finances_api_pages (organization_id, captured_at);

-- -----------------------------------------------------------------------------
-- amazon_finances_event_groups — FinancialEventGroup snapshots
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.amazon_finances_event_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,
  marketplace_id text,
  event_group_id text NOT NULL,
  finances_api_version text NOT NULL,
  processing_status text,
  fund_transfer_status text,
  original_total jsonb,
  converted_total jsonb,
  financial_event_group_start timestamptz,
  financial_event_group_end timestamptz,
  source_run_id uuid NOT NULL REFERENCES public.amazon_finances_source_runs (id) ON DELETE RESTRICT,
  payload_digest text NOT NULL,
  raw_payload jsonb NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amazon_finances_event_groups_org_version_group_digest_key UNIQUE (
    organization_id,
    finances_api_version,
    event_group_id,
    payload_digest
  )
);

COMMENT ON TABLE public.amazon_finances_event_groups IS
  'Append-only FinancialEventGroup snapshots; latest per Amazon id via v_amazon_finances_event_groups_latest.';

CREATE INDEX IF NOT EXISTS idx_amazon_finances_event_groups_org_group
  ON public.amazon_finances_event_groups (organization_id, event_group_id);

CREATE INDEX IF NOT EXISTS idx_amazon_finances_event_groups_source_run
  ON public.amazon_finances_event_groups (source_run_id);

CREATE INDEX IF NOT EXISTS idx_amazon_finances_event_groups_org_ingested
  ON public.amazon_finances_event_groups (organization_id, ingested_at DESC);

-- -----------------------------------------------------------------------------
-- amazon_finances_events — flattened financial events
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.amazon_finances_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  event_group_row_id uuid NOT NULL REFERENCES public.amazon_finances_event_groups (id) ON DELETE RESTRICT,
  event_group_id text NOT NULL,
  source_run_id uuid NOT NULL REFERENCES public.amazon_finances_source_runs (id) ON DELETE RESTRICT,
  finances_api_version text NOT NULL,
  event_type text NOT NULL,
  amazon_event_id text,
  posted_at timestamptz,
  amount numeric,
  currency text,
  order_id text,
  seller_order_id text,
  sku text,
  shipment_id text,
  removal_order_id text,
  reimbursement_id text,
  adjustment_id text,
  reference_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_fragment jsonb NOT NULL,
  payload_digest text NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amazon_finances_events_org_group_digest_key UNIQUE (organization_id, event_group_id, payload_digest)
);

COMMENT ON TABLE public.amazon_finances_events IS
  'Flattened Finances API events extracted from group payloads (append-only archive).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_amazon_finances_events_org_version_group_type_amazon_id
  ON public.amazon_finances_events (
    organization_id,
    finances_api_version,
    event_group_id,
    event_type,
    amazon_event_id
  )
  WHERE amazon_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_amazon_finances_events_org_order
  ON public.amazon_finances_events (organization_id, order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_amazon_finances_events_org_reimbursement
  ON public.amazon_finances_events (organization_id, reimbursement_id)
  WHERE reimbursement_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_amazon_finances_events_org_posted
  ON public.amazon_finances_events (organization_id, posted_at);

CREATE INDEX IF NOT EXISTS idx_amazon_finances_events_event_group_row
  ON public.amazon_finances_events (event_group_row_id);

-- -----------------------------------------------------------------------------
-- Latest event group per Amazon id (read model)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_amazon_finances_event_groups_latest AS
SELECT DISTINCT ON (organization_id, finances_api_version, event_group_id)
  id,
  organization_id,
  store_id,
  marketplace_id,
  event_group_id,
  finances_api_version,
  processing_status,
  fund_transfer_status,
  original_total,
  converted_total,
  financial_event_group_start,
  financial_event_group_end,
  source_run_id,
  payload_digest,
  raw_payload,
  ingested_at
FROM public.amazon_finances_event_groups
ORDER BY organization_id, finances_api_version, event_group_id, ingested_at DESC;

COMMENT ON VIEW public.v_amazon_finances_event_groups_latest IS
  'Latest ingested snapshot per (organization_id, finances_api_version, event_group_id).';

-- -----------------------------------------------------------------------------
-- updated_at on source_runs only
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

DROP TRIGGER IF EXISTS trg_amazon_finances_source_runs_set_updated_at ON public.amazon_finances_source_runs;
CREATE TRIGGER trg_amazon_finances_source_runs_set_updated_at
  BEFORE UPDATE ON public.amazon_finances_source_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
ALTER TABLE public.amazon_finances_source_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amazon_finances_api_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amazon_finances_event_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amazon_finances_events ENABLE ROW LEVEL SECURITY;

-- service_role — source_runs (state updates + inserts)
DROP POLICY IF EXISTS amazon_finances_source_runs_service_role_all ON public.amazon_finances_source_runs;
CREATE POLICY amazon_finances_source_runs_service_role_all
  ON public.amazon_finances_source_runs
  AS PERMISSIVE FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- service_role — append-only archive tables (insert + select; no update/delete policies)
DROP POLICY IF EXISTS amazon_finances_api_pages_service_role_insert ON public.amazon_finances_api_pages;
CREATE POLICY amazon_finances_api_pages_service_role_insert
  ON public.amazon_finances_api_pages
  AS PERMISSIVE FOR INSERT
  TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS amazon_finances_api_pages_service_role_select ON public.amazon_finances_api_pages;
CREATE POLICY amazon_finances_api_pages_service_role_select
  ON public.amazon_finances_api_pages
  AS PERMISSIVE FOR SELECT
  TO service_role
  USING (true);

DROP POLICY IF EXISTS amazon_finances_event_groups_service_role_insert ON public.amazon_finances_event_groups;
CREATE POLICY amazon_finances_event_groups_service_role_insert
  ON public.amazon_finances_event_groups
  AS PERMISSIVE FOR INSERT
  TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS amazon_finances_event_groups_service_role_select ON public.amazon_finances_event_groups;
CREATE POLICY amazon_finances_event_groups_service_role_select
  ON public.amazon_finances_event_groups
  AS PERMISSIVE FOR SELECT
  TO service_role
  USING (true);

DROP POLICY IF EXISTS amazon_finances_events_service_role_insert ON public.amazon_finances_events;
CREATE POLICY amazon_finances_events_service_role_insert
  ON public.amazon_finances_events
  AS PERMISSIVE FOR INSERT
  TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS amazon_finances_events_service_role_select ON public.amazon_finances_events;
CREATE POLICY amazon_finances_events_service_role_select
  ON public.amazon_finances_events
  AS PERMISSIVE FOR SELECT
  TO service_role
  USING (true);

-- authenticated — org-scoped read
DROP POLICY IF EXISTS amazon_finances_source_runs_select_own_org ON public.amazon_finances_source_runs;
CREATE POLICY amazon_finances_source_runs_select_own_org
  ON public.amazon_finances_source_runs
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS amazon_finances_api_pages_select_own_org ON public.amazon_finances_api_pages;
CREATE POLICY amazon_finances_api_pages_select_own_org
  ON public.amazon_finances_api_pages
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS amazon_finances_event_groups_select_own_org ON public.amazon_finances_event_groups;
CREATE POLICY amazon_finances_event_groups_select_own_org
  ON public.amazon_finances_event_groups
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS amazon_finances_events_select_own_org ON public.amazon_finances_events;
CREATE POLICY amazon_finances_events_select_own_org
  ON public.amazon_finances_events
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON public.amazon_finances_source_runs TO service_role;
GRANT SELECT, INSERT ON public.amazon_finances_api_pages TO service_role;
GRANT SELECT, INSERT ON public.amazon_finances_event_groups TO service_role;
GRANT SELECT, INSERT ON public.amazon_finances_events TO service_role;

GRANT SELECT ON public.amazon_finances_source_runs TO authenticated;
GRANT SELECT ON public.amazon_finances_api_pages TO authenticated;
GRANT SELECT ON public.amazon_finances_event_groups TO authenticated;
GRANT SELECT ON public.amazon_finances_events TO authenticated;
GRANT SELECT ON public.v_amazon_finances_event_groups_latest TO authenticated;
GRANT SELECT ON public.v_amazon_finances_event_groups_latest TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
