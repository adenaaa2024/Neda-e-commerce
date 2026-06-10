-- FIX-SCANNER-DELETE-RPC-RV_RI_SCANNED_QUANTITY
-- release_expected_item_unit SELECT INTO anonymous record must alias scanned_quantity;
-- without AS scanned_quantity the 4th column is named "greatest" and v_ri.scanned_quantity raises at runtime.

BEGIN;

CREATE OR REPLACE FUNCTION public.release_expected_item_unit(
  p_return_item_id uuid,
  p_organization_id uuid,
  p_soft_delete boolean DEFAULT true
)
RETURNS TABLE (
  released boolean,
  parent_restored_id uuid,
  child_archived_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_ri record;
  v_child public.expected_packages%ROWTYPE;
  v_parent_id uuid;
  v_other_links bigint;
  v_qty integer;
BEGIN
  SELECT
    ri.id,
    ri.expected_item_id,
    ri.deleted_at,
    GREATEST(COALESCE(ri.scanned_quantity, 1), 1) AS scanned_quantity
  INTO v_ri
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id
    AND ri.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND OR v_ri.expected_item_id IS NULL THEN
    IF p_soft_delete AND FOUND AND v_ri.deleted_at IS NULL THEN
      UPDATE public.return_items SET deleted_at = now() WHERE id = p_return_item_id;
    ELSIF NOT p_soft_delete AND FOUND THEN
      DELETE FROM public.return_items WHERE id = p_return_item_id;
    END IF;
    released := false;
    RETURN NEXT;
    RETURN;
  END IF;

  v_qty := GREATEST(COALESCE(v_ri.scanned_quantity, 1), 1);

  SELECT ep.*
    INTO v_child
  FROM public.expected_packages ep
  WHERE ep.id = v_ri.expected_item_id
  FOR UPDATE;

  v_parent_id := v_child.parent_expected_package_id;

  IF COALESCE(v_child.build_source, '') = 'receive_allocated' AND v_parent_id IS NOT NULL THEN
    UPDATE public.expected_packages
      SET expected_scan_quantity = GREATEST(COALESCE(expected_scan_quantity, 0) - v_qty, 0),
          updated_at = now()
    WHERE id = v_child.id;

    UPDATE public.expected_packages
      SET expected_scan_quantity = COALESCE(expected_scan_quantity, 0) + v_qty,
          updated_at = now()
    WHERE id = v_parent_id;

    SELECT count(*) INTO v_other_links
    FROM public.return_items ri
    WHERE ri.expected_item_id = v_child.id
      AND ri.id <> p_return_item_id
      AND ri.deleted_at IS NULL;

    IF GREATEST(COALESCE(v_child.expected_scan_quantity, 0) - v_qty, 0) = 0 AND v_other_links = 0 THEN
      DELETE FROM public.expected_packages WHERE id = v_child.id;
      child_archived_id := v_child.id;
    END IF;

    parent_restored_id := v_parent_id;
  END IF;

  IF p_soft_delete THEN
    UPDATE public.return_items
      SET deleted_at = now(), expected_item_id = NULL, updated_at = now()
    WHERE id = p_return_item_id;
  ELSE
    UPDATE public.return_items
      SET expected_item_id = NULL, updated_at = now()
    WHERE id = p_return_item_id;
  END IF;

  released := true;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.release_expected_item_unit(uuid, uuid, boolean) IS
  'Release expected_packages remainder by return_items.scanned_quantity (alias fix 20260913120000).';

-- Guard permission helper when user_permissions table is absent (staging parity).
CREATE OR REPLACE FUNCTION public._ops_actor_has_permission(
  p_actor_id uuid,
  p_permission_key text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_actor_id IS NULL THEN
    RETURN current_setting('role', true) = 'service_role';
  END IF;

  IF to_regclass('public.user_permissions') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.user_permissions up
      JOIN public.permissions perm ON perm.id = up.permission_id
      WHERE up.profile_id = p_actor_id
        AND perm.key = p_permission_key
    ) THEN
      RETURN true;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profiles pr
    JOIN public.role_permissions rp ON rp.role_id = pr.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE pr.id = p_actor_id
      AND perm.key = p_permission_key
  ) THEN
    RETURN true;
  END IF;

  IF to_regclass('public.user_groups') IS NOT NULL AND to_regclass('public.group_permissions') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.user_groups ug
      JOIN public.group_permissions gp ON gp.group_id = ug.group_id
      JOIN public.permissions perm ON perm.id = gp.permission_id
      WHERE ug.profile_id = p_actor_id
        AND perm.key = p_permission_key
    ) THEN
      RETURN true;
    END IF;
  END IF;

  RETURN false;
END;
$fn$;

COMMIT;
