-- =============================================================================
-- PHASE-RLS-POLICY-BATCH-CLAIM-AND-AMAZON-REIMBURSEMENTS-V1
-- Staging first; original only after Maysam approval.
--
-- amazon_reimbursements: raw SP-API domain — RLS already on, zero policies.
-- claim_reimbursements: claim-layer outcome — RLS off (may be absent on staging).
--
-- Pattern: amazon import tables — service_role ALL; authenticated org SELECT only.
-- No authenticated writes (imports + claim outcomes use service_role server-side).
-- =============================================================================

BEGIN;

-- ── amazon_reimbursements ────────────────────────────────────────────────────

ALTER TABLE public.amazon_reimbursements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS amazon_reimbursements_service_role_all ON public.amazon_reimbursements;
CREATE POLICY amazon_reimbursements_service_role_all
  ON public.amazon_reimbursements
  AS PERMISSIVE FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS amazon_reimbursements_select_own_org ON public.amazon_reimbursements;
CREATE POLICY amazon_reimbursements_select_own_org
  ON public.amazon_reimbursements
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

COMMENT ON POLICY amazon_reimbursements_service_role_all ON public.amazon_reimbursements IS
  'PHASE-RLS-POLICY-BATCH-V1: SP-API import + server readmodels use service_role.';

COMMENT ON POLICY amazon_reimbursements_select_own_org ON public.amazon_reimbursements IS
  'PHASE-RLS-POLICY-BATCH-V1: org-scoped read for authenticated Claim Center / PIM.';

-- ── claim_reimbursements (optional — table may not exist on all environments) ─

DO $$
BEGIN
  IF to_regclass('public.claim_reimbursements') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.claim_reimbursements ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS claim_reimbursements_service_role_all ON public.claim_reimbursements';
    EXECUTE $pol$
      CREATE POLICY claim_reimbursements_service_role_all
        ON public.claim_reimbursements
        AS PERMISSIVE FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true)
    $pol$;

    EXECUTE 'DROP POLICY IF EXISTS claim_reimbursements_select_own_org ON public.claim_reimbursements';
    EXECUTE $pol$
      CREATE POLICY claim_reimbursements_select_own_org
        ON public.claim_reimbursements
        FOR SELECT
        TO authenticated
        USING (organization_id = public.get_my_organization_id())
    $pol$;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
