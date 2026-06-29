-- =============================================================================
-- PHASE-PEOPLE-ORG-CHART-1C-1 — Atomic profile position assignment RPC (staging)
-- Closes current open assignment (ends_at IS NULL) and inserts a new current row.
-- No hard deletes. Does not modify profiles, positions, groups, or user_groups.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public._assert_assign_profile_position_caller(
  p_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    -- Backend / service_role / direct SQL smoke tests (no JWT).
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    LEFT JOIN public.roles r ON r.id = p.role_id
    WHERE p.id = v_uid
      AND p.organization_id = p_organization_id
      AND (
        r.key IN ('tenant_admin', 'admin')
        OR (
          p.role_id IS NULL
          AND lower(trim(COALESCE(p.role, ''))) IN ('tenant_admin', 'admin')
        )
      )
  ) THEN
    RAISE EXCEPTION
      'assign_profile_position: forbidden — caller must be tenant_admin for organization %',
      p_organization_id;
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public._assert_assign_profile_position_caller(uuid) IS
  'Internal gate for assign_profile_position: tenant_admin in org when auth.uid() is set; '
  'no-op when auth.uid() is null (service_role / direct SQL).';

CREATE OR REPLACE FUNCTION public.assign_profile_position(
  p_organization_id uuid,
  p_profile_id uuid,
  p_position_id uuid,
  p_group_id uuid DEFAULT NULL,
  p_manager_profile_id uuid DEFAULT NULL,
  p_starts_at timestamptz DEFAULT now(),
  p_assigned_by uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.profile_position_assignments
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_current public.profile_position_assignments%ROWTYPE;
  v_new public.profile_position_assignments%ROWTYPE;
  v_group_type text;
  v_cursor uuid;
  v_depth integer := 0;
  v_max_depth constant integer := 1000;
BEGIN
  IF p_organization_id IS NULL OR p_profile_id IS NULL OR p_position_id IS NULL THEN
    RAISE EXCEPTION 'assign_profile_position: organization_id, profile_id, and position_id are required';
  END IF;

  IF p_starts_at IS NULL THEN
    RAISE EXCEPTION 'assign_profile_position: p_starts_at must not be null';
  END IF;

  PERFORM public._assert_assign_profile_position_caller(p_organization_id);

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = p_profile_id
      AND p.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION
      'assign_profile_position: profile % does not belong to organization %',
      p_profile_id,
      p_organization_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.positions pos
    WHERE pos.id = p_position_id
      AND pos.organization_id = p_organization_id
      AND pos.deleted_at IS NULL
      AND pos.is_active = true
  ) THEN
    RAISE EXCEPTION
      'assign_profile_position: position % is missing, inactive, deleted, or not in organization %',
      p_position_id,
      p_organization_id;
  END IF;

  IF p_group_id IS NOT NULL THEN
    SELECT g.group_type
      INTO v_group_type
    FROM public.groups g
    WHERE g.id = p_group_id
      AND g.organization_id = p_organization_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'assign_profile_position: group % does not belong to organization %',
        p_group_id,
        p_organization_id;
    END IF;

    IF v_group_type NOT IN ('team', 'department', 'queue', 'access_group') THEN
      RAISE EXCEPTION
        'assign_profile_position: group % has invalid group_type % (expected team, department, queue, or access_group)',
        p_group_id,
        v_group_type;
    END IF;
  END IF;

  IF p_manager_profile_id IS NOT NULL THEN
    IF p_manager_profile_id = p_profile_id THEN
      RAISE EXCEPTION
        'assign_profile_position: manager cannot be the same profile as assignee (%)',
        p_profile_id;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.profiles mp
      WHERE mp.id = p_manager_profile_id
        AND mp.organization_id = p_organization_id
    ) THEN
      RAISE EXCEPTION
        'assign_profile_position: manager profile % does not belong to organization %',
        p_manager_profile_id,
        p_organization_id;
    END IF;

    v_cursor := p_manager_profile_id;
    WHILE v_cursor IS NOT NULL LOOP
      IF v_cursor = p_profile_id THEN
        RAISE EXCEPTION
          'assign_profile_position: manager cycle detected for profile % (chain reaches assignee)',
          p_profile_id;
      END IF;

      v_depth := v_depth + 1;
      IF v_depth > v_max_depth THEN
        RAISE EXCEPTION
          'assign_profile_position: manager chain exceeds max depth % (possible cycle)',
          v_max_depth;
      END IF;

      SELECT ppa.manager_profile_id
        INTO v_cursor
      FROM public.profile_position_assignments ppa
      WHERE ppa.organization_id = p_organization_id
        AND ppa.profile_id = v_cursor
        AND ppa.ends_at IS NULL
      LIMIT 1;
    END LOOP;
  END IF;

  IF p_assigned_by IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.profiles ab
    WHERE ab.id = p_assigned_by
      AND ab.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION
      'assign_profile_position: assigned_by profile % does not belong to organization %',
      p_assigned_by,
      p_organization_id;
  END IF;

  SELECT ppa.*
    INTO v_current
  FROM public.profile_position_assignments ppa
  WHERE ppa.organization_id = p_organization_id
    AND ppa.profile_id = p_profile_id
    AND ppa.ends_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    IF p_starts_at < v_current.starts_at THEN
      RAISE EXCEPTION
        'assign_profile_position: p_starts_at (%) cannot be before current assignment starts_at (%)',
        p_starts_at,
        v_current.starts_at;
    END IF;

    UPDATE public.profile_position_assignments
      SET ends_at = p_starts_at,
          updated_at = now()
    WHERE id = v_current.id;
  END IF;

  INSERT INTO public.profile_position_assignments (
    organization_id,
    profile_id,
    position_id,
    group_id,
    manager_profile_id,
    starts_at,
    ends_at,
    assigned_by,
    notes
  )
  VALUES (
    p_organization_id,
    p_profile_id,
    p_position_id,
    p_group_id,
    p_manager_profile_id,
    p_starts_at,
    NULL,
    p_assigned_by,
    NULLIF(trim(p_notes), '')
  )
  RETURNING * INTO v_new;

  RETURN v_new;
END;
$fn$;

COMMENT ON FUNCTION public.assign_profile_position(
  uuid, uuid, uuid, uuid, uuid, timestamptz, uuid, text
) IS
  'Atomically close the current profile position assignment (ends_at := p_starts_at) and insert '
  'a new open row. Preserves history. Validates org alignment, active position, group type, '
  'and manager cycles on current assignments.';

REVOKE ALL ON FUNCTION public._assert_assign_profile_position_caller(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_profile_position(
  uuid, uuid, uuid, uuid, uuid, timestamptz, uuid, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.assign_profile_position(
  uuid, uuid, uuid, uuid, uuid, timestamptz, uuid, text
) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
