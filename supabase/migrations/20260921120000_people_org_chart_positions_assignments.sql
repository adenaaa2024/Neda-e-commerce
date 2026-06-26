-- =============================================================================
-- PHASE-PEOPLE-ORG-CHART-1A — Positions + profile position assignment history
-- Staging schema only. No UI, no API, no Task Center writes.
--
-- positions: tenant catalog (Platform Settings / Platform Access definitions)
-- profile_position_assignments: assignment history (System Settings workflows)
-- Current assignment derived from ends_at IS NULL (no is_current column).
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. public.positions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.positions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL
    REFERENCES public.organizations (id) ON DELETE CASCADE,
  code             text        NOT NULL,
  title            text        NOT NULL,
  description      text        NULL,
  level            integer     NULL,
  is_active        boolean     NOT NULL DEFAULT true,
  deleted_at       timestamptz NULL,
  created_by       uuid        NULL
    REFERENCES public.profiles (id) ON DELETE SET NULL,
  updated_by       uuid        NULL
    REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT positions_code_not_blank_check
    CHECK (length(trim(code)) > 0),
  CONSTRAINT positions_title_not_blank_check
    CHECK (length(trim(title)) > 0)
);

COMMENT ON TABLE public.positions IS
  'Tenant position catalog for people org chart. Soft-delete via deleted_at; '
  'Platform Settings / Platform Access owns definitions.';

COMMENT ON COLUMN public.positions.code IS
  'Stable machine code within the tenant; unique among non-deleted rows (case-insensitive).';

COMMENT ON COLUMN public.positions.level IS
  'Optional hierarchy level for org chart ordering; not a substitute for assignment history.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_positions_active_org_code_lower
  ON public.positions (organization_id, lower(code))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_positions_org_is_active
  ON public.positions (organization_id, is_active);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. public.profile_position_assignments
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.profile_position_assignments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL
    REFERENCES public.organizations (id) ON DELETE CASCADE,
  profile_id          uuid        NOT NULL
    REFERENCES public.profiles (id) ON DELETE CASCADE,
  position_id         uuid        NOT NULL
    REFERENCES public.positions (id) ON DELETE RESTRICT,
  group_id            uuid        NULL
    REFERENCES public.groups (id) ON DELETE SET NULL,
  manager_profile_id  uuid        NULL
    REFERENCES public.profiles (id) ON DELETE SET NULL,
  starts_at           timestamptz NOT NULL DEFAULT now(),
  ends_at             timestamptz NULL,
  assigned_by         uuid        NULL
    REFERENCES public.profiles (id) ON DELETE SET NULL,
  notes               text        NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profile_position_assignments_ends_after_start_check
    CHECK (ends_at IS NULL OR starts_at <= ends_at),
  CONSTRAINT profile_position_assignments_manager_not_self_check
    CHECK (manager_profile_id IS NULL OR manager_profile_id <> profile_id)
);

COMMENT ON TABLE public.profile_position_assignments IS
  'Position assignment history per person. Current row: ends_at IS NULL '
  '(at most one per profile per organization). Close history by setting ends_at; no hard deletes.';

COMMENT ON COLUMN public.profile_position_assignments.group_id IS
  'Optional team/department/queue from public.groups at assignment time.';

COMMENT ON COLUMN public.profile_position_assignments.manager_profile_id IS
  'Optional reports-to manager for this assignment window; not stored on profiles.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_position_assignments_current_per_profile_org
  ON public.profile_position_assignments (organization_id, profile_id)
  WHERE ends_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_profile_position_assignments_organization_id
  ON public.profile_position_assignments (organization_id);

CREATE INDEX IF NOT EXISTS idx_profile_position_assignments_profile_id
  ON public.profile_position_assignments (profile_id);

CREATE INDEX IF NOT EXISTS idx_profile_position_assignments_position_id
  ON public.profile_position_assignments (position_id);

CREATE INDEX IF NOT EXISTS idx_profile_position_assignments_manager_profile_id
  ON public.profile_position_assignments (manager_profile_id)
  WHERE manager_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profile_position_assignments_group_id
  ON public.profile_position_assignments (group_id)
  WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profile_position_assignments_org_ends_at
  ON public.profile_position_assignments (organization_id, ends_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Org alignment validation (profile, position, group, manager)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.assert_profile_position_assignment_org_alignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = NEW.profile_id
      AND p.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'profile_position_assignments: profile % does not belong to organization %',
      NEW.profile_id,
      NEW.organization_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.positions pos
    WHERE pos.id = NEW.position_id
      AND pos.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'profile_position_assignments: position % does not belong to organization %',
      NEW.position_id,
      NEW.organization_id;
  END IF;

  IF NEW.group_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.groups g
    WHERE g.id = NEW.group_id
      AND g.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'profile_position_assignments: group % does not belong to organization %',
      NEW.group_id,
      NEW.organization_id;
  END IF;

  IF NEW.manager_profile_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.profiles mp
    WHERE mp.id = NEW.manager_profile_id
      AND mp.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION
      'profile_position_assignments: manager profile % does not belong to organization %',
      NEW.manager_profile_id,
      NEW.organization_id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.assert_profile_position_assignment_org_alignment() IS
  'Ensures profile, position, optional group, and optional manager share assignment.organization_id.';

DROP TRIGGER IF EXISTS trg_profile_position_assignments_org_alignment
  ON public.profile_position_assignments;
CREATE TRIGGER trg_profile_position_assignments_org_alignment
  BEFORE INSERT OR UPDATE OF organization_id, profile_id, position_id, group_id, manager_profile_id
  ON public.profile_position_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_profile_position_assignment_org_alignment();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. updated_at (reuse public.set_updated_at)
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_positions_updated_at ON public.positions;
CREATE TRIGGER trg_positions_updated_at
  BEFORE UPDATE ON public.positions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_profile_position_assignments_updated_at
  ON public.profile_position_assignments;
CREATE TRIGGER trg_profile_position_assignments_updated_at
  BEFORE UPDATE ON public.profile_position_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Row level security (pattern: user_store_assignments + profiles org SELECT)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_position_assignments ENABLE ROW LEVEL SECURITY;

-- positions: org members read catalog
DROP POLICY IF EXISTS positions_select_own_org ON public.positions;
CREATE POLICY positions_select_own_org
  ON public.positions
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS positions_insert_tenant_admin ON public.positions;
CREATE POLICY positions_insert_tenant_admin
  ON public.positions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      LEFT JOIN public.roles r ON r.id = p.role_id
      WHERE p.id = auth.uid()
        AND p.organization_id = positions.organization_id
        AND (
          r.key IN ('tenant_admin', 'admin')
          OR (
            p.role_id IS NULL
            AND lower(trim(COALESCE(p.role, ''))) IN ('tenant_admin', 'admin')
          )
        )
    )
  );

DROP POLICY IF EXISTS positions_update_tenant_admin ON public.positions;
CREATE POLICY positions_update_tenant_admin
  ON public.positions
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      LEFT JOIN public.roles r ON r.id = p.role_id
      WHERE p.id = auth.uid()
        AND p.organization_id = positions.organization_id
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
        AND p.organization_id = positions.organization_id
        AND (
          r.key IN ('tenant_admin', 'admin')
          OR (
            p.role_id IS NULL
            AND lower(trim(COALESCE(p.role, ''))) IN ('tenant_admin', 'admin')
          )
        )
    )
  );

DROP POLICY IF EXISTS positions_all_platform_admin ON public.positions;
CREATE POLICY positions_all_platform_admin
  ON public.positions
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

-- profile_position_assignments: own rows + org-wide read for org chart
DROP POLICY IF EXISTS profile_position_assignments_select_own
  ON public.profile_position_assignments;
CREATE POLICY profile_position_assignments_select_own
  ON public.profile_position_assignments
  FOR SELECT
  TO authenticated
  USING (
    profile_id = auth.uid()
    AND organization_id = public.get_my_organization_id()
  );

DROP POLICY IF EXISTS profile_position_assignments_select_own_org
  ON public.profile_position_assignments;
CREATE POLICY profile_position_assignments_select_own_org
  ON public.profile_position_assignments
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS profile_position_assignments_insert_tenant_admin
  ON public.profile_position_assignments;
CREATE POLICY profile_position_assignments_insert_tenant_admin
  ON public.profile_position_assignments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      LEFT JOIN public.roles r ON r.id = p.role_id
      WHERE p.id = auth.uid()
        AND p.organization_id = profile_position_assignments.organization_id
        AND (
          r.key IN ('tenant_admin', 'admin')
          OR (
            p.role_id IS NULL
            AND lower(trim(COALESCE(p.role, ''))) IN ('tenant_admin', 'admin')
          )
        )
    )
  );

DROP POLICY IF EXISTS profile_position_assignments_update_tenant_admin
  ON public.profile_position_assignments;
CREATE POLICY profile_position_assignments_update_tenant_admin
  ON public.profile_position_assignments
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      LEFT JOIN public.roles r ON r.id = p.role_id
      WHERE p.id = auth.uid()
        AND p.organization_id = profile_position_assignments.organization_id
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
        AND p.organization_id = profile_position_assignments.organization_id
        AND (
          r.key IN ('tenant_admin', 'admin')
          OR (
            p.role_id IS NULL
            AND lower(trim(COALESCE(p.role, ''))) IN ('tenant_admin', 'admin')
          )
        )
    )
  );

DROP POLICY IF EXISTS profile_position_assignments_all_platform_admin
  ON public.profile_position_assignments;
CREATE POLICY profile_position_assignments_all_platform_admin
  ON public.profile_position_assignments
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

-- Grants: no authenticated DELETE (soft-close via ends_at / deleted_at)
GRANT SELECT, INSERT, UPDATE ON public.positions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.profile_position_assignments TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.positions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_position_assignments TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
