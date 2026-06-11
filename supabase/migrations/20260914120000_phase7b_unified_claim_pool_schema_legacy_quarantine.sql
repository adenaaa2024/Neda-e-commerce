-- PHASE-7B — unified claim pool schema + legacy quarantine.
-- claim_candidates becomes the single claim pool. Untrusted legacy rows
-- (9,055-row burst import, ~96% evidence missing, no insert code in repo)
-- are quarantined in place — never deleted.
--
-- Guarantees:
--   * Additive only: no column drops, no row deletes, no claim_cases/claim_lines changes.
--   * Object-existence guards on every statement (safe re-run, safe on original later).
--   * No automatic claim promotion; no scanner receive logic touched.

BEGIN;

-- ── 1) Additive columns on claim_candidates ──────────────────────────────────
-- source_table, source_row_id, claim_family already exist (NOT NULL).
ALTER TABLE public.claim_candidates
  ADD COLUMN IF NOT EXISTS source_kind                  text,
  ADD COLUMN IF NOT EXISTS dedupe_key                   text,
  ADD COLUMN IF NOT EXISTS source_event_key             text,
  ADD COLUMN IF NOT EXISTS expected_quantity            numeric,
  ADD COLUMN IF NOT EXISTS actual_quantity              numeric,
  ADD COLUMN IF NOT EXISTS delta_quantity               numeric,
  ADD COLUMN IF NOT EXISTS package_id                   uuid,
  ADD COLUMN IF NOT EXISTS pallet_id                    uuid,
  ADD COLUMN IF NOT EXISTS return_item_id               uuid,
  ADD COLUMN IF NOT EXISTS expected_package_id          uuid,
  ADD COLUMN IF NOT EXISTS shipment_scope_key           text,
  ADD COLUMN IF NOT EXISTS intake_run_id                uuid,
  ADD COLUMN IF NOT EXISTS superseded_by_candidate_id   uuid,
  ADD COLUMN IF NOT EXISTS quarantined_at               timestamptz,
  ADD COLUMN IF NOT EXISTS quarantine_reason            text,
  ADD COLUMN IF NOT EXISTS rejected_at                  timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_reason              text,
  ADD COLUMN IF NOT EXISTS metadata                     jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.claim_candidates.source_kind IS
  'Trusted generator family that produced this candidate. NULL only during transition; legacy_seed = untrusted pre-7B import.';
COMMENT ON COLUMN public.claim_candidates.dedupe_key IS
  'Generator-computed idempotency key. Unique per organization when present.';
COMMENT ON COLUMN public.claim_candidates.quarantine_reason IS
  'Why this candidate is excluded from active claim work (e.g. legacy_untrusted_burst_import).';

-- Self-FK for supersede chains (guarded: pg_constraint check).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.claim_candidates'::regclass
      AND conname = 'claim_candidates_superseded_by_fkey'
  ) THEN
    ALTER TABLE public.claim_candidates
      ADD CONSTRAINT claim_candidates_superseded_by_fkey
      FOREIGN KEY (superseded_by_candidate_id)
      REFERENCES public.claim_candidates(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- ── 2) source_kind allowed values (CHECK, NULL allowed during transition) ────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.claim_candidates'::regclass
      AND conname = 'claim_candidates_source_kind_check'
  ) THEN
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
          'legacy_seed'
        )
      );
  END IF;
END $$;

-- ── 3) Quarantine backfill of legacy rows (idempotent, no deletes) ───────────
-- Every pre-7B row (source_kind IS NULL) is the untrusted burst import.
-- Preserve the prior candidate_status in metadata before overwriting.
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

-- ── 4) Unique + lookup indexes ────────────────────────────────────────────────
-- Trusted-generator identity. NULLS NOT DISTINCT so NULL store_id cannot
-- be used to bypass uniqueness (PG15+; staging/original are PG17).
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_candidates_source_identity
  ON public.claim_candidates (
    organization_id, store_id, source_kind, source_table, source_row_id, claim_family
  )
  NULLS NOT DISTINCT
  WHERE source_row_id IS NOT NULL AND superseded_by_candidate_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_candidates_dedupe_key
  ON public.claim_candidates (organization_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claim_candidates_org_store_status
  ON public.claim_candidates (organization_id, store_id, candidate_status);

CREATE INDEX IF NOT EXISTS idx_claim_candidates_org_source_kind
  ON public.claim_candidates (organization_id, source_kind);

CREATE INDEX IF NOT EXISTS idx_claim_candidates_org_claim_family
  ON public.claim_candidates (organization_id, claim_family);

CREATE INDEX IF NOT EXISTS idx_claim_candidates_metadata_gin
  ON public.claim_candidates USING gin (metadata);

-- ── 5) claim_evidence → claim_candidates link (additive) ─────────────────────
ALTER TABLE public.claim_evidence
  ADD COLUMN IF NOT EXISTS claim_candidate_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.claim_evidence'::regclass
      AND conname = 'claim_evidence_claim_candidate_id_fkey'
  ) THEN
    ALTER TABLE public.claim_evidence
      ADD CONSTRAINT claim_evidence_claim_candidate_id_fkey
      FOREIGN KEY (claim_candidate_id)
      REFERENCES public.claim_candidates(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_claim_evidence_claim_candidate
  ON public.claim_evidence (claim_candidate_id)
  WHERE claim_candidate_id IS NOT NULL;

COMMENT ON COLUMN public.claim_evidence.claim_candidate_id IS
  'Optional pre-promotion evidence link to the unified claim_candidates pool.';

COMMIT;
