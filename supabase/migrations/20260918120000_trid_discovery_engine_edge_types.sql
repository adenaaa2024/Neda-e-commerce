-- =============================================================================
-- TRID-DISCOVERY-ENGINE — extend claim_reference_edges edge_type vocabulary for
-- automatic reference discovery. No new tables, no new columns.
--   * order_reference  — candidate -> amazon order id
--   * shipment_scope   — candidate -> tracking / package_code shipment scope
--   * ledger_reference — candidate -> inventory ledger rows by reference_id
--   * safet_reference  — candidate -> SAFE-T claim rows
--   * product_link     — candidate -> resolved products row
-- Dedupe stays enforced by uq_claim_reference_edges_candidate_natural.
-- =============================================================================

BEGIN;

ALTER TABLE public.claim_reference_edges
  DROP CONSTRAINT IF EXISTS claim_reference_edges_edge_type_chk;

ALTER TABLE public.claim_reference_edges
  ADD CONSTRAINT claim_reference_edges_edge_type_chk CHECK (edge_type IN (
    -- legacy CCE draft-era types
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
    'financial_reference',
    -- TRID discovery engine types
    'order_reference',
    'shipment_scope',
    'ledger_reference',
    'safet_reference',
    'product_link'
  ));

COMMIT;

NOTIFY pgrst, 'reload schema';
