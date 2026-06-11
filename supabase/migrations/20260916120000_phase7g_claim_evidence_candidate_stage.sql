-- PHASE-7G — allow candidate-stage evidence (pre-promotion).
-- 7B added claim_evidence.claim_candidate_id; claim_case_id NOT NULL blocked its use.
-- Additive/guarded: case_id becomes nullable with an at-least-one-parent CHECK.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'claim_evidence'
      AND column_name = 'claim_case_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.claim_evidence ALTER COLUMN claim_case_id DROP NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.claim_evidence'::regclass
      AND conname = 'claim_evidence_parent_link_check'
  ) THEN
    ALTER TABLE public.claim_evidence
      ADD CONSTRAINT claim_evidence_parent_link_check
      CHECK (claim_case_id IS NOT NULL OR claim_candidate_id IS NOT NULL);
  END IF;
END $$;

COMMENT ON COLUMN public.claim_evidence.claim_case_id IS
  'Nullable since 7G: evidence may attach to a claim candidate (pre-promotion) or a claim case.';
