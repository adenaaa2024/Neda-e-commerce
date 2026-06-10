-- FIX-SCANNER-DELETE-UNIT-PERMISSION-WIRING
-- Standardize operator-mobile scanned-unit delete on operations.operator_mobile.delete_item
-- Map scanner delete into delete_return_item_with_expected_release without broadening ops.delete_return_item.

-- ── 1. Permission catalog (operator mobile correction keys) ─────────────────
INSERT INTO public.permissions (key, name, module, feature_key, action, description)
VALUES
  (
    'operations.operator_mobile.edit_item',
    'Edit scanned units',
    'operations',
    'operator_mobile',
    'manage',
    'Correct scanned quantity or product linkage on operator mobile receive'
  ),
  (
    'operations.operator_mobile.delete_item',
    'Delete scanned units',
    'operations',
    'operator_mobile',
    'manage',
    'Soft-void a package-linked scanned return_items row from operator mobile receive'
  ),
  (
    'operations.operator_mobile.move_box',
    'Move boxes between pallets',
    'operations',
    'operator_mobile',
    'manage',
    'Move a saved intake box to another pallet (mobile scanner)'
  ),
  (
    'operations.operator_mobile.void_box',
    'Void boxes',
    'operations',
    'operator_mobile',
    'manage',
    'Soft-void an empty intake box (no saved return items)'
  ),
  (
    'operations.operator_mobile.reset_entry',
    'Reset mobile receiving draft',
    'operations',
    'operator_mobile',
    'manage',
    'Clear local draft state on mobile receiving (no database delete)'
  )
ON CONFLICT (key) DO UPDATE SET
  name        = EXCLUDED.name,
  module      = EXCLUDED.module,
  feature_key = EXCLUDED.feature_key,
  action      = EXCLUDED.action,
  description = EXCLUDED.description;

-- ── 2. Role grants (Platform Access spine) ─────────────────────────────────
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.key IN ('super_admin', 'admin', 'tenant_admin', 'operator', 'system_employee')
  AND p.key IN (
    'operations.operator_mobile.edit_item',
    'operations.operator_mobile.delete_item',
    'operations.operator_mobile.move_box',
    'operations.operator_mobile.void_box',
    'operations.operator_mobile.reset_entry'
  )
ON CONFLICT DO NOTHING;

-- ── 3. Permission resolution (role + group + direct user grants) ───────────
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

  IF EXISTS (
    SELECT 1
    FROM public.user_permissions up
    JOIN public.permissions perm ON perm.id = up.permission_id
    WHERE up.profile_id = p_actor_id
      AND perm.key = p_permission_key
  ) THEN
    RETURN true;
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

  RETURN false;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._ops_require_permission(
  p_actor_id uuid,
  p_permission_key text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RETURN public._ops_actor_has_permission(p_actor_id, p_permission_key);
END;
$fn$;

CREATE OR REPLACE FUNCTION public._ops_actor_is_elevated_correction_role(p_actor_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_role_key text;
BEGIN
  IF p_actor_id IS NULL THEN
    RETURN current_setting('role', true) = 'service_role';
  END IF;

  SELECT coalesce(r.key, lower(replace(replace(btrim(pr.role), ' ', '_'), '-', '_')))
  INTO v_role_key
  FROM public.profiles pr
  LEFT JOIN public.roles r ON r.id = pr.role_id
  WHERE pr.id = p_actor_id;

  RETURN coalesce(v_role_key, '') IN (
    'super_admin', 'admin', 'tenant_admin', 'system_employee', 'system_admin'
  );
END;
$fn$;

-- Scanner-scoped delete: package-linked return_items only; operator owns row when created_by set.
CREATE OR REPLACE FUNCTION public._ops_can_scanner_delete_return_item(
  p_actor_id uuid,
  p_organization_id uuid,
  p_return_item_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_ri public.return_items%ROWTYPE;
BEGIN
  IF NOT public._ops_actor_has_permission(p_actor_id, 'operations.operator_mobile.delete_item') THEN
    RETURN false;
  END IF;

  SELECT * INTO v_ri
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id
    AND ri.organization_id = p_organization_id
    AND ri.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Operator mobile scanned units are always package-linked.
  IF v_ri.package_id IS NULL THEN
    RETURN false;
  END IF;

  IF NOT public._ops_actor_is_elevated_correction_role(p_actor_id) THEN
    IF v_ri.created_by IS NOT NULL AND v_ri.created_by IS DISTINCT FROM p_actor_id THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$fn$;

-- ── 4. delete_return_item_with_expected_release — scanner permission mapping ─
CREATE OR REPLACE FUNCTION public.delete_return_item_with_expected_release(
  p_organization_id uuid,
  p_return_item_id  uuid,
  p_actor_id        uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_reason          text DEFAULT NULL,
  p_undo_batch_id   uuid DEFAULT NULL
)
RETURNS TABLE (ok boolean, undo_batch_id uuid, message text)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_ri public.return_items%ROWTYPE;
  v_batch uuid;
  v_released boolean;
  v_parent uuid;
  v_child uuid;
  v_alloc_snap jsonb;
  v_claim_count integer;
  v_has_full_delete boolean;
  v_has_scanner_delete boolean;
BEGIN
  v_has_full_delete := public._ops_actor_has_permission(p_actor_id, 'ops.delete_return_item');
  v_has_scanner_delete := public._ops_can_scanner_delete_return_item(
    p_actor_id, p_organization_id, p_return_item_id
  );

  IF NOT v_has_full_delete AND NOT v_has_scanner_delete THEN
    IF NOT public._ops_actor_has_permission(p_actor_id, 'operations.operator_mobile.delete_item') THEN
      RETURN QUERY SELECT false, NULL::uuid, 'permission_denied';
      RETURN;
    END IF;

    SELECT * INTO v_ri
    FROM public.return_items ri
    WHERE ri.id = p_return_item_id AND ri.organization_id = p_organization_id;

    IF NOT FOUND THEN
      RETURN QUERY SELECT false, NULL::uuid, 'return_item_not_found';
      RETURN;
    END IF;

    IF v_ri.package_id IS NULL THEN
      RETURN QUERY SELECT false, NULL::uuid, 'not_operator_mobile_scanned_unit';
      RETURN;
    END IF;

    IF NOT public._ops_actor_is_elevated_correction_role(p_actor_id)
       AND v_ri.created_by IS NOT NULL
       AND v_ri.created_by IS DISTINCT FROM p_actor_id THEN
      RETURN QUERY SELECT false, NULL::uuid, 'permission_denied';
      RETURN;
    END IF;

    RETURN QUERY SELECT false, NULL::uuid, 'permission_denied';
    RETURN;
  END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.audit_events ae
    WHERE ae.organization_id = p_organization_id AND ae.idempotency_key = p_idempotency_key
  ) THEN
    SELECT ae.undo_batch_id INTO v_batch
    FROM public.audit_events ae
    WHERE ae.organization_id = p_organization_id AND ae.idempotency_key = p_idempotency_key
    LIMIT 1;
    RETURN QUERY SELECT true, v_batch, 'idempotent_replay';
    RETURN;
  END IF;

  SELECT * INTO v_ri
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id AND ri.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, 'return_item_not_found';
    RETURN;
  END IF;

  IF v_ri.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT true, v_ri.undo_batch_id, 'already_deleted';
    RETURN;
  END IF;

  -- Scanner path cannot delete unrelated return_items (no package link).
  IF v_has_scanner_delete AND NOT v_has_full_delete AND v_ri.package_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, 'not_operator_mobile_scanned_unit';
    RETURN;
  END IF;

  v_claim_count := public._ops_active_claims_for_return_item(p_organization_id, p_return_item_id);
  IF v_claim_count > 0 THEN
    RETURN QUERY SELECT false, NULL::uuid, 'active_claim_submission';
    RETURN;
  END IF;

  v_batch := COALESCE(p_undo_batch_id, public._ops_undo_batch_start(p_organization_id, p_actor_id, p_reason));

  IF v_ri.expected_item_id IS NOT NULL THEN
    v_alloc_snap := public._ops_expected_allocation_snapshot(v_ri.expected_item_id);
  END IF;

  PERFORM public._ops_undo_capture(
    p_organization_id, v_batch, 'return_item', v_ri.id,
    to_jsonb(v_ri),
    jsonb_build_object('package_id', v_ri.package_id, 'pallet_id', v_ri.pallet_id),
    v_alloc_snap
  );

  IF v_ri.expected_item_id IS NOT NULL THEN
    SELECT r.released, r.parent_restored_id, r.child_archived_id
    INTO v_released, v_parent, v_child
    FROM public.release_expected_item_unit(p_return_item_id, p_organization_id, false) r;

    PERFORM public._ops_log_audit_event(
      p_organization_id, 'return_item', v_ri.id, 'expected_release', p_actor_id, v_batch,
      NULL, jsonb_build_object('released', v_released, 'parent_restored_id', v_parent, 'child_archived_id', v_child)
    );
  END IF;

  UPDATE public.return_items
  SET deleted_at = now(),
      deleted_by = p_actor_id,
      undo_batch_id = v_batch,
      updated_at = now()
  WHERE id = p_return_item_id;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'return_item', v_ri.id, 'delete_return_item', p_actor_id, v_batch,
    to_jsonb(v_ri), NULL, jsonb_build_object('reason', p_reason, 'idempotency_key', p_idempotency_key)
  );

  RETURN QUERY SELECT true, v_batch, 'deleted';
END;
$fn$;
