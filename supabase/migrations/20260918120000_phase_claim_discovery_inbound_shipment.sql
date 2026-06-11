-- Phase Claim Discovery — add inbound_shipment source_kind to claim_candidates check.

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.claim_candidates'::regclass
    AND conname = 'claim_candidates_source_kind_check';

  IF v_def IS NULL OR v_def NOT LIKE '%inbound_shipment%' THEN
    IF v_def IS NOT NULL THEN
      ALTER TABLE public.claim_candidates
        DROP CONSTRAINT claim_candidates_source_kind_check;
    END IF;
    ALTER TABLE public.claim_candidates
      ADD CONSTRAINT claim_candidates_source_kind_check
      CHECK (
        source_kind IS NULL OR source_kind IN (
          'scanner_physical_review',
          'amazon_removal_api',
          'reimbursement',
          'settlement',
          'transaction',
          'inventory_ledger',
          'safet',
          'delayed_not_received',
          'shipment_discrepancy',
          'inbound_shipment',
          'manual_import',
          'orbit_fra',
          'legacy_seed'
        )
      );
  END IF;
END $$;
