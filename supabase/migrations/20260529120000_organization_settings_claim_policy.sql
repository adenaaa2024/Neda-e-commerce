-- CLAIM-CUTOFF-POLICY-PHASE1 — organization_settings.claim_policy
-- Apply on staging with operator approval before Settings UI persist.

BEGIN;

ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS claim_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.organization_settings.claim_policy IS
  'Claim cutoff v1: scan_go_live_date, claim_start_date, claim_eligibility_window_days, grouping, hold flags. Empty {} blocks auto-claims.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_settings_claim_policy_is_object'
  ) THEN
    ALTER TABLE public.organization_settings
      ADD CONSTRAINT organization_settings_claim_policy_is_object
      CHECK (jsonb_typeof(claim_policy) = 'object');
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
