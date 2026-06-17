-- PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-AND-GUARDED-EXECUTE-V1
-- PROPOSED ONLY — apply when APPROVED_MANUAL_FILING_STATUS_ENTRY_SCHEMA_MIGRATION_V1=yes
-- Pilot V1 can defer these columns and use submission_id + source_payload only.

DO $$ BEGIN
  IF to_regclass('public.claim_submissions') IS NOT NULL THEN
    ALTER TABLE public.claim_submissions
      ADD COLUMN IF NOT EXISTS filed_at timestamptz,
      ADD COLUMN IF NOT EXISTS filed_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS external_case_url text,
      ADD COLUMN IF NOT EXISTS filing_notes text,
      ADD COLUMN IF NOT EXISTS status_reason text;

    COMMENT ON COLUMN public.claim_submissions.filed_at IS
      'Operator-attested manual filing timestamp (Amazon portal); MENORIX does not submit.';
    COMMENT ON COLUMN public.claim_submissions.filed_by IS
      'Profile id of operator who recorded manual filing attestation.';
    COMMENT ON COLUMN public.claim_submissions.external_case_url IS
      'Optional deep link to Amazon Seller Central case.';
    COMMENT ON COLUMN public.claim_submissions.filing_notes IS
      'Operator notes at manual filing record time.';
    COMMENT ON COLUMN public.claim_submissions.status_reason IS
      'Human-readable status context for rejected/evidence_requested (later transitions).';

    CREATE UNIQUE INDEX IF NOT EXISTS claim_submissions_store_external_case_uidx
      ON public.claim_submissions (organization_id, store_id, submission_id)
      WHERE submission_id IS NOT NULL AND status NOT IN ('rejected');
  END IF;
END $$;
