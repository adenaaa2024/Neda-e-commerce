-- =============================================================================
-- NEXT-CLAIM-30: public.user_store_assignments
--
-- Per-user store access within a tenant (view | act | submit).
-- Active row: revoked_at IS NULL (and application applies starts_at / ends_at).
-- No wildcard rows (store_id always set); all-store access is resolver-only (future).
--
-- RLS: conservative authenticated policies. Service role bypasses RLS — server
-- code must still enforce assertClaimPermission / catalog rules (see docs).
--
-- PROTECTED: No seed data; no workflow tables.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. Table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_store_assignments (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL
    REFERENCES public.organizations (id) ON DELETE RESTRICT,
  profile_id       uuid        NOT NULL
    REFERENCES public.profiles (id) ON DELETE CASCADE,
  store_id         uuid        NOT NULL
    REFERENCES public.stores (id) ON DELETE RESTRICT,
  access_level     text        NOT NULL,
  starts_at        timestamptz NOT NULL DEFAULT now(),
  ends_at          timestamptz NULL,
  source           text        NOT NULL DEFAULT 'manual',
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz NULL,
  CONSTRAINT user_store_assignments_access_level_check
    CHECK (access_level IN ('view', 'act', 'submit')),
  CONSTRAINT user_store_assignments_ends_after_start_check
    CHECK (ends_at IS NULL OR starts_at <= ends_at)
);

COMMENT ON TABLE public.user_store_assignments IS
  'Maps a user (profiles.id) to a store within a tenant for least-privilege claims and workflow access. '
  'One active assignment per (profile_id, store_id) when revoked_at IS NULL. '
  'No NULL store_id / wildcard rows — tenant-wide or platform exceptions are applied in application resolvers.';

COMMENT ON COLUMN public.user_store_assignments.access_level IS
  'view: read-only store context; act: operational mutations short of external submit; '
  'submit: includes channel submission / irreversible marketplace actions (resolver: submit implies act implies view).';

COMMENT ON COLUMN public.user_store_assignments.revoked_at IS
  'Soft revoke. Active assignment iff revoked_at IS NULL (application also enforces starts_at / ends_at).';

COMMENT ON COLUMN public.user_store_assignments.organization_id IS
  'Tenant boundary. FK ON DELETE RESTRICT: cannot delete an organization while assignments reference it.';

COMMENT ON COLUMN public.user_store_assignments.store_id IS
  'Concrete store; NOT NULL by design — no sentinel wildcard rows in this table.';

-- ─────────────────────────────────────────────────────────────────────────────
-- B. Indexes
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_store_assignments_active_profile_store
  ON public.user_store_assignments (profile_id, store_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_store_assignments_org_profile_revoked
  ON public.user_store_assignments (organization_id, profile_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_user_store_assignments_org_store_revoked
  ON public.user_store_assignments (organization_id, store_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_user_store_assignments_ends_at_active
  ON public.user_store_assignments (ends_at)
  WHERE revoked_at IS NULL AND ends_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- C. Org / store alignment (stores.organization_id must match row)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.assert_user_store_assignment_org_matches_store()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.stores s
    WHERE s.id = NEW.store_id
      AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'user_store_assignments: store % does not belong to organization %',
      NEW.store_id,
      NEW.organization_id;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.assert_user_store_assignment_org_matches_store() IS
  'Ensures user_store_assignments.organization_id matches stores.organization_id for NEW.store_id. '
  'Postgres cannot FK-enforce this without a unique (stores.id, stores.organization_id) target.';

DROP TRIGGER IF EXISTS trg_user_store_assignments_org_store ON public.user_store_assignments;
CREATE TRIGGER trg_user_store_assignments_org_store
  BEFORE INSERT OR UPDATE OF organization_id, store_id
  ON public.user_store_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_user_store_assignment_org_matches_store();

-- ─────────────────────────────────────────────────────────────────────────────
-- D. updated_at (reuse public.set_updated_at — do not redefine here)
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_user_store_assignments_updated_at ON public.user_store_assignments;
CREATE TRIGGER trg_user_store_assignments_updated_at
  BEFORE UPDATE ON public.user_store_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- E. Row level security (conservative; service_role bypasses RLS)
--
-- Assumptions (NEXT-CLAIM-30):
--   - Tenant admin is roles.key IN ('tenant_admin','admin') on profiles.role_id,
--     with profiles.organization_id equal to the assignment row organization_id,
--     OR legacy profiles.role_id IS NULL and lower(profiles.role) matches.
--   - Platform operators: roles.scope = 'system' AND roles.key IN
--       ('super_admin','system_admin') — full read/write on all assignment rows.
--   - system_employee and other system keys are intentionally NOT granted here;
--     extend in a future migration if product requires.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.user_store_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_store_assignments_select_own ON public.user_store_assignments;
CREATE POLICY user_store_assignments_select_own
  ON public.user_store_assignments
  FOR SELECT
  TO authenticated
  USING (
    profile_id = auth.uid()
      AND organization_id = public.get_my_organization_id()
  );

DROP POLICY IF EXISTS user_store_assignments_all_tenant_admin ON public.user_store_assignments;
CREATE POLICY user_store_assignments_all_tenant_admin
  ON public.user_store_assignments
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      LEFT JOIN public.roles r ON r.id = p.role_id
      WHERE p.id = auth.uid()
        AND p.organization_id = user_store_assignments.organization_id
        AND (
          r.key IN ('tenant_admin', 'admin')
          OR (
            p.role_id IS NULL
            AND lower(trim(COALESCE(p.role, ''))) IN ('tenant_admin', 'admin')
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      LEFT JOIN public.roles r ON r.id = p.role_id
      WHERE p.id = auth.uid()
        AND p.organization_id = user_store_assignments.organization_id
        AND (
          r.key IN ('tenant_admin', 'admin')
          OR (
            p.role_id IS NULL
            AND lower(trim(COALESCE(p.role, ''))) IN ('tenant_admin', 'admin')
          )
        )
    )
  );

DROP POLICY IF EXISTS user_store_assignments_all_platform_admin ON public.user_store_assignments;
CREATE POLICY user_store_assignments_all_platform_admin
  ON public.user_store_assignments
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      LEFT JOIN public.roles r ON r.id = p.role_id
      WHERE p.id = auth.uid()
        AND (
          (r.scope = 'system' AND r.key IN ('super_admin', 'system_admin'))
          OR (
            p.role_id IS NULL
            AND lower(trim(COALESCE(p.role, ''))) IN ('super_admin', 'system_admin')
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      LEFT JOIN public.roles r ON r.id = p.role_id
      WHERE p.id = auth.uid()
        AND (
          (r.scope = 'system' AND r.key IN ('super_admin', 'system_admin'))
          OR (
            p.role_id IS NULL
            AND lower(trim(COALESCE(p.role, ''))) IN ('super_admin', 'system_admin')
          )
        )
    )
  );

GRANT SELECT ON public.user_store_assignments TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.user_store_assignments TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_store_assignments TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
