-- PHASE-7B (rev 2) — ORBIT-FRA claim source model extension on the unified
-- claim_candidates pool. Delta on top of 20260914120000 (already applied):
--   * reference_id / reference_type   — ORBIT-FRA reference ID type per category
--   * dispute_deadline / days_remaining — claim window status per category
--   * recovery_value / cogs_unit      — expected recovery + SellerSnap COGS
--   * source_kind gains 'orbit_fra'
--   * indexes for reference / event_date / dispute window lookups
--
-- Guarantees: additive only, no row deletes, claim_cases/claim_lines untouched,
-- object-existence guards on every statement (safe re-run, original-safe).

BEGIN;

-- ── 1) ORBIT-FRA columns (additive; event_date already exists) ───────────────
ALTER TABLE public.claim_candidates
  ADD COLUMN IF NOT EXISTS reference_id      text,
  ADD COLUMN IF NOT EXISTS reference_type    text,
  ADD COLUMN IF NOT EXISTS dispute_deadline  date,
  ADD COLUMN IF NOT EXISTS days_remaining    integer,
  ADD COLUMN IF NOT EXISTS recovery_value    numeric,
  ADD COLUMN IF NOT EXISTS cogs_unit         numeric;

COMMENT ON COLUMN public.claim_candidates.reference_id IS
  'ORBIT-FRA reference id for the claim category (order id, shipment id, removal order id, reimbursement id, ...).';
COMMENT ON COLUMN public.claim_candidates.reference_type IS
  'ORBIT-FRA reference id TYPE per claim category (e.g. order_id, fba_shipment_id, removal_order_id, case_id).';
COMMENT ON COLUMN public.claim_candidates.dispute_deadline IS
  'End of the Amazon dispute window for this claim category. Window status derives from this date.';
COMMENT ON COLUMN public.claim_candidates.days_remaining IS
  'Snapshot of days remaining in the dispute window at last intake run (refreshed by generators; not a live value).';
COMMENT ON COLUMN public.claim_candidates.recovery_value IS
  'Expected recovery amount (units_affected x cogs_unit or report amount, per ORBIT-FRA category rule).';
COMMENT ON COLUMN public.claim_candidates.cogs_unit IS
  'Per-unit COGS sourced from SellerSnap at intake time.';

-- ── 2) source_kind check gains orbit_fra (guarded swap, only when missing) ───
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
  FROM pg_constraint
  WHERE conrelid = 'public.claim_candidates'::regclass
    AND conname = 'claim_candidates_source_kind_check';

  IF v_def IS NULL OR v_def NOT LIKE '%orbit_fra%' THEN
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
          'manual_import',
          'orbit_fra',
          'legacy_seed'
        )
      );
  END IF;
END $$;

-- ── 3) Legacy quarantine re-assert (idempotent; 0 rows when 7B already ran) ──
UPDATE public.claim_candidates
SET
  source_kind       = 'legacy_seed',
  metadata          = metadata || jsonb_build_object('pre_quarantine_status', candidate_status),
  candidate_status  = CASE
                        WHEN candidate_status IN ('quarantined', 'quarantined_missing_source')
                          THEN candidate_status
                        ELSE 'quarantined'
                      END,
  quarantined_at    = COALESCE(quarantined_at, now()),
  quarantine_reason = COALESCE(quarantine_reason, 'legacy_untrusted_burst_import'),
  updated_at        = now()
WHERE source_kind IS NULL;

-- ── 4) ORBIT-FRA lookup indexes ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_claim_candidates_org_reference
  ON public.claim_candidates (organization_id, reference_type, reference_id)
  WHERE reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claim_candidates_org_event_date
  ON public.claim_candidates (organization_id, event_date);

CREATE INDEX IF NOT EXISTS idx_claim_candidates_org_dispute_deadline
  ON public.claim_candidates (organization_id, dispute_deadline)
  WHERE dispute_deadline IS NOT NULL;

COMMIT;
