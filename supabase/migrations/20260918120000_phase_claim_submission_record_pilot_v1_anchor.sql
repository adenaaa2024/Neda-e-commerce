-- PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1
-- Anchor pilot manual-filing submission rows to claim_cases (return_id optional for pilot).

ALTER TABLE public.claim_submissions
  ADD COLUMN IF NOT EXISTS claim_case_id uuid REFERENCES public.claim_cases (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.claim_submissions.claim_case_id IS
  'Pilot/case-bridge anchor — manual filing record rows link here; legacy rows use return_id.';

-- Pilot rows may exist without a return_items FK.
ALTER TABLE public.claim_submissions
  ALTER COLUMN return_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claim_submissions_org_claim_case
  ON public.claim_submissions (organization_id, claim_case_id)
  WHERE claim_case_id IS NOT NULL;

-- One active non-rejected submission per pilot claim case (soft-cancel uses rejected).
CREATE UNIQUE INDEX IF NOT EXISTS claim_submissions_pilot_case_active_uidx
  ON public.claim_submissions (organization_id, claim_case_id)
  WHERE claim_case_id IS NOT NULL AND status NOT IN ('rejected');
