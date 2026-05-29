-- =============================================================================
-- CLAIM-RETURN-LINE-FOUNDATION — additive public.claim_lines
-- Applied on staging per claim-return-line-foundation-schema-apply approval.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.claim_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,

  claim_candidate_id uuid REFERENCES public.claim_candidates (id) ON DELETE SET NULL,
  claim_candidate_draft_id uuid REFERENCES public.claim_candidate_drafts (id) ON DELETE SET NULL,

  return_item_id uuid REFERENCES public.return_items (id) ON DELETE SET NULL,
  expected_package_id uuid REFERENCES public.expected_packages (id) ON DELETE SET NULL,
  expected_package_root_id uuid REFERENCES public.expected_packages (id) ON DELETE SET NULL,

  product_id uuid REFERENCES public.products (id) ON DELETE SET NULL,
  resolved_product_id uuid REFERENCES public.products (id) ON DELETE SET NULL,

  package_id uuid REFERENCES public.packages (id) ON DELETE SET NULL,
  pallet_id uuid REFERENCES public.pallets (id) ON DELETE SET NULL,
  slip_content_id uuid REFERENCES public.slip_contents (id) ON DELETE SET NULL,

  tracking_number text,
  order_id text,
  sku text,
  fnsku text,
  asin text,

  source_table text,
  source_row_id text,
  source_detail_row_id uuid,
  source_shipment_row_id uuid,

  line_grain text NOT NULL,
  discrepancy_kind text NOT NULL,
  quantity_basis text,
  count_basis text,
  quantity_expected numeric(12, 4),
  quantity_actual numeric(12, 4),
  quantity_delta numeric(12, 4),

  status text NOT NULL DEFAULT 'detected',
  status_reason text,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT claim_lines_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT claim_lines_line_grain_chk CHECK (line_grain IN (
    'return_item',
    'expected_group',
    'import_source'
  )),
  CONSTRAINT claim_lines_discrepancy_kind_chk CHECK (discrepancy_kind IN (
    'short',
    'overage',
    'damage',
    'wrong_item',
    'missing_product_link',
    'removal_financial',
    'import_candidate',
    'other'
  )),
  CONSTRAINT claim_lines_quantity_basis_chk CHECK (
    quantity_basis IS NULL OR quantity_basis IN ('units', 'cases', 'weight_lb', 'unknown')
  ),
  CONSTRAINT claim_lines_count_basis_chk CHECK (
    count_basis IS NULL OR count_basis IN ('scan_count', 'expected_scan_quantity', 'package_count', 'unknown')
  ),
  CONSTRAINT claim_lines_status_chk CHECK (status IN (
    'detected',
    'evidence_needed',
    'claim_ready',
    'submitted',
    'reimbursed',
    'rejected',
    'closed'
  )),
  CONSTRAINT claim_lines_grain_fk_chk CHECK (
    (line_grain = 'return_item' AND return_item_id IS NOT NULL)
    OR (line_grain = 'expected_group' AND expected_package_root_id IS NOT NULL)
    OR (line_grain = 'import_source' AND source_table IS NOT NULL AND source_row_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.claim_lines IS
  'Operational claim line: one discrepancy at item, expected-group, or import-source grain. Detection inbox remains claim_candidates.';

CREATE INDEX idx_claim_lines_org_store_status
  ON public.claim_lines (organization_id, store_id, status);

CREATE INDEX idx_claim_lines_org_return_item
  ON public.claim_lines (organization_id, return_item_id)
  WHERE return_item_id IS NOT NULL;

CREATE INDEX idx_claim_lines_org_expected_package
  ON public.claim_lines (organization_id, expected_package_id)
  WHERE expected_package_id IS NOT NULL;

CREATE INDEX idx_claim_lines_org_expected_root
  ON public.claim_lines (organization_id, expected_package_root_id)
  WHERE expected_package_root_id IS NOT NULL;

CREATE INDEX idx_claim_lines_claim_candidate
  ON public.claim_lines (claim_candidate_id)
  WHERE claim_candidate_id IS NOT NULL;

CREATE INDEX idx_claim_lines_org_source
  ON public.claim_lines (organization_id, source_table, source_row_id)
  WHERE source_table IS NOT NULL;

CREATE INDEX idx_claim_lines_org_resolved_product
  ON public.claim_lines (organization_id, resolved_product_id)
  WHERE resolved_product_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_claim_lines_set_updated_at ON public.claim_lines;
CREATE TRIGGER trg_claim_lines_set_updated_at
  BEFORE UPDATE ON public.claim_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.claim_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "claim_lines_service_role_all" ON public.claim_lines;
CREATE POLICY "claim_lines_service_role_all"
  ON public.claim_lines
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "claim_lines_select_own_org" ON public.claim_lines;
CREATE POLICY "claim_lines_select_own_org"
  ON public.claim_lines
  FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_lines TO service_role;
GRANT SELECT ON public.claim_lines TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
