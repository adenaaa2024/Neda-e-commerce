-- =============================================================================
-- DELETE CASCADE + UNDO AUDIT FOUNDATION v2 (PROPOSED — do not apply without approval)
-- Replaces draft: 20260901120000_delete_cascade_undo_audit_foundation.sql
-- Applied staging: 20260903120000_delete_cascade_undo_audit_foundation_v2.sql
-- Prerequisite: 20260830120000_expected_receive_split_item_level.sql
-- Apply: staging only when APPROVED_DELETE_CASCADE_UNDO_AUDIT_V2_MIGRATION=true
-- Fixes: release/move RPC signatures, claim gates, snapshot depth, preview/apply restore
-- =============================================================================

BEGIN;

-- ── 1. Retention setting (per org) ───────────────────────────────────────────
ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS undo_snapshot_retention_days integer NOT NULL DEFAULT 30;

COMMENT ON COLUMN public.organization_settings.undo_snapshot_retention_days IS
  'Days to retain undo_snapshots before purge job may delete (default 30).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_settings_undo_retention_chk'
  ) THEN
    ALTER TABLE public.organization_settings
      ADD CONSTRAINT organization_settings_undo_retention_chk
      CHECK (undo_snapshot_retention_days BETWEEN 1 AND 365);
  END IF;
END $$;

-- ── 2. Soft-delete metadata (additive) ───────────────────────────────────────
ALTER TABLE public.pallets
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS undo_batch_id uuid;

ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS undo_batch_id uuid;

ALTER TABLE public.return_items
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS undo_batch_id uuid;

COMMENT ON COLUMN public.pallets.undo_batch_id IS
  'Links soft-delete to undo_snapshots / restore batch.';
COMMENT ON COLUMN public.packages.undo_batch_id IS
  'Links soft-delete to undo_snapshots / restore batch.';
COMMENT ON COLUMN public.return_items.undo_batch_id IS
  'Links soft-delete to undo_snapshots / restore batch.';

-- ── 3. audit_events ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,
  entity_kind text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  actor_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  actor_kind text NOT NULL DEFAULT 'operator',
  undo_batch_id uuid,
  idempotency_key text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_entity_kind_chk CHECK (
    entity_kind IN ('pallet', 'package', 'return_item', 'batch')
  ),
  CONSTRAINT audit_events_action_chk CHECK (
    action IN (
      'soft_delete', 'restore', 'move_parent', 'restore_preview', 'restore_apply',
      'cascade_delete_pallet', 'cascade_delete_package', 'delete_return_item',
      'expected_release', 'expected_move'
    )
  ),
  CONSTRAINT audit_events_actor_kind_chk CHECK (
    actor_kind IN ('operator', 'system', 'agent')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_events_idempotency
  ON public.audit_events (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_org_entity_created
  ON public.audit_events (organization_id, entity_kind, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_undo_batch
  ON public.audit_events (undo_batch_id)
  WHERE undo_batch_id IS NOT NULL;

-- ── 4. undo_snapshots ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.undo_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  undo_batch_id uuid NOT NULL,
  entity_kind text NOT NULL,
  entity_id uuid NOT NULL,
  row_snapshot jsonb NOT NULL,
  parent_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_allocation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CONSTRAINT undo_snapshots_entity_kind_chk CHECK (
    entity_kind IN ('pallet', 'package', 'return_item', 'expected_package_alloc')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_undo_snapshots_batch_entity
  ON public.undo_snapshots (undo_batch_id, entity_kind, entity_id);

CREATE INDEX IF NOT EXISTS idx_undo_snapshots_org_expires
  ON public.undo_snapshots (organization_id, expires_at)
  WHERE expires_at IS NOT NULL;

-- ── 5. restore_conflicts ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.restore_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  undo_batch_id uuid NOT NULL,
  entity_kind text NOT NULL,
  entity_id uuid NOT NULL,
  conflict_code text NOT NULL,
  conflict_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  blocking boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restore_conflicts_code_chk CHECK (
    conflict_code IN (
      'duplicate_lpn',
      'duplicate_tracking',
      'active_claim_submission',
      'expected_alloc_row_missing',
      'allocation_conflict',
      'parent_missing',
      'parent_still_deleted',
      'permission_denied',
      'retention_expired',
      'snapshot_not_found'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_restore_conflicts_batch
  ON public.restore_conflicts (undo_batch_id, blocking);

-- ── 6. Permissions ───────────────────────────────────────────────────────────
INSERT INTO public.permissions (key, name, module, feature_key, action, description)
VALUES
  ('ops.delete_pallet_cascade', 'Delete pallet (cascade)', 'operations', 'undo', 'manage',
   'Soft-delete pallet and contained packages/return_items with undo batch'),
  ('ops.delete_package_cascade', 'Delete package (cascade)', 'operations', 'undo', 'manage',
   'Soft-delete package and return_items with undo batch'),
  ('ops.delete_return_item', 'Delete return item', 'operations', 'undo', 'manage',
   'Soft-delete return_item; releases item-level expected allocation'),
  ('ops.move_return_item_parent', 'Move return item parent', 'operations', 'undo', 'manage',
   'Reassign package/pallet; calls move_expected_item_unit when allocated'),
  ('ops.restore_deleted_entity', 'Restore deleted entity', 'operations', 'undo', 'manage',
   'Restore single entity from undo_snapshots'),
  ('ops.preview_restore_undo_batch', 'Preview undo restore', 'operations', 'undo', 'read',
   'Non-mutating conflict scan for undo_batch_id'),
  ('ops.apply_restore_undo_batch', 'Apply undo restore', 'operations', 'undo', 'manage',
   'Restore batch after preview confirm'),
  ('ops.view_undo_history', 'View undo history', 'operations', 'undo', 'read',
   'Read audit_events and undo_snapshots for org')
ON CONFLICT (key) DO NOTHING;

-- ── 7. Internal helpers ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._ops_undo_batch_start(
  p_organization_id uuid,
  p_actor_id        uuid DEFAULT NULL,
  p_reason          text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_batch uuid := gen_random_uuid();
  v_retention integer;
  v_expires timestamptz;
BEGIN
  SELECT COALESCE(os.undo_snapshot_retention_days, 30)
  INTO v_retention
  FROM public.organization_settings os
  WHERE os.organization_id = p_organization_id;

  v_expires := now() + make_interval(days => v_retention);

  INSERT INTO public.audit_events (
    organization_id, entity_kind, entity_id, action, actor_id,
    undo_batch_id, metadata
  )
  VALUES (
    p_organization_id, 'batch', v_batch, 'cascade_delete_pallet', p_actor_id,
    v_batch, jsonb_build_object('phase', 'batch_open', 'reason', p_reason, 'expires_at', v_expires)
  );

  RETURN v_batch;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._ops_undo_capture(
  p_organization_id uuid,
  p_undo_batch_id   uuid,
  p_entity_kind     text,
  p_entity_id       uuid,
  p_row_snapshot    jsonb,
  p_parent_refs     jsonb DEFAULT '{}'::jsonb,
  p_expected_alloc  jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_expires timestamptz;
BEGIN
  SELECT MIN(us.expires_at) INTO v_expires
  FROM public.undo_snapshots us
  WHERE us.undo_batch_id = p_undo_batch_id;

  IF v_expires IS NULL THEN
    SELECT now() + make_interval(days => COALESCE(os.undo_snapshot_retention_days, 30))
    INTO v_expires
    FROM public.organization_settings os
    WHERE os.organization_id = p_organization_id;
  END IF;

  INSERT INTO public.undo_snapshots (
    organization_id, undo_batch_id, entity_kind, entity_id,
    row_snapshot, parent_refs, expected_allocation, expires_at
  )
  VALUES (
    p_organization_id, p_undo_batch_id, p_entity_kind, p_entity_id,
    p_row_snapshot, p_parent_refs, p_expected_alloc, v_expires
  )
  ON CONFLICT (undo_batch_id, entity_kind, entity_id) DO UPDATE
  SET row_snapshot = EXCLUDED.row_snapshot,
      parent_refs = EXCLUDED.parent_refs,
      expected_allocation = EXCLUDED.expected_allocation;
END;
$fn$;

CREATE OR REPLACE FUNCTION public._ops_expected_allocation_snapshot(p_expected_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_child public.expected_packages%ROWTYPE;
  v_parent_qty numeric;
BEGIN
  IF p_expected_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_child
  FROM public.expected_packages ep
  WHERE ep.id = p_expected_item_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('expected_item_id', p_expected_item_id, 'missing', true);
  END IF;

  IF v_child.parent_expected_package_id IS NOT NULL THEN
    SELECT COALESCE(ep.expected_scan_quantity, 0) INTO v_parent_qty
    FROM public.expected_packages ep
    WHERE ep.id = v_child.parent_expected_package_id;
  END IF;

  RETURN jsonb_build_object(
    'expected_item_id', p_expected_item_id,
    'child_ep', to_jsonb(v_child),
    'parent_ep_id', v_child.parent_expected_package_id,
    'parent_ep_qty_before', v_parent_qty
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public._ops_slip_refs_for_package(p_package_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_rows jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(sc) ORDER BY sc.sort_index NULLS LAST, sc.created_at), '[]'::jsonb)
  INTO v_rows
  FROM public.slip_contents sc
  WHERE sc.package_id = p_package_id;

  RETURN COALESCE(v_rows, '[]'::jsonb);
END;
$fn$;

CREATE OR REPLACE FUNCTION public._ops_active_claims_for_return_item(
  p_organization_id uuid,
  p_return_item_id  uuid
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_n integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'claim_lines'
  ) THEN
    SELECT count(*)::integer INTO v_n
    FROM public.claim_lines cl
    WHERE cl.organization_id = p_organization_id
      AND cl.return_item_id = p_return_item_id
      AND cl.status NOT IN ('rejected', 'closed');
  END IF;

  IF v_n = 0 THEN
    SELECT count(*)::integer INTO v_n
    FROM public.claim_submissions cs
    WHERE cs.return_id = p_return_item_id
      AND cs.status NOT IN ('rejected');
  END IF;

  RETURN v_n;
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
  IF p_actor_id IS NULL THEN
    RETURN current_setting('role', true) = 'service_role';
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.user_permissions up
    JOIN public.permissions perm ON perm.id = up.permission_id
    WHERE up.profile_id = p_actor_id
      AND perm.key = p_permission_key
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public._ops_log_audit_event(
  p_organization_id uuid,
  p_entity_kind     text,
  p_entity_id       uuid,
  p_action          text,
  p_actor_id        uuid,
  p_undo_batch_id   uuid DEFAULT NULL,
  p_before          jsonb DEFAULT NULL,
  p_after           jsonb DEFAULT NULL,
  p_metadata        jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.audit_events (
    organization_id, entity_kind, entity_id, action, actor_id,
    undo_batch_id, before_state, after_state, metadata
  )
  VALUES (
    p_organization_id, p_entity_kind, p_entity_id, p_action, p_actor_id,
    p_undo_batch_id, p_before, p_after, p_metadata
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$fn$;

-- ── 8. delete_return_item_with_expected_release (FIXED release RPC) ───────────
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
BEGIN
  IF NOT public._ops_require_permission(p_actor_id, 'ops.delete_return_item') THEN
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

  IF v_ri.package_id IS NOT NULL THEN
    UPDATE public.packages
    SET actual_item_count = greatest(COALESCE(actual_item_count, 0) - 1, 0),
        updated_at = now()
    WHERE id = v_ri.package_id;
  END IF;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'return_item', v_ri.id, 'delete_return_item', p_actor_id, v_batch,
    to_jsonb(v_ri), NULL, jsonb_build_object('reason', p_reason, 'idempotency_key', p_idempotency_key)
  );

  RETURN QUERY SELECT true, v_batch, 'deleted';
END;
$fn$;

-- ── 9. delete_package_cascade ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_package_cascade(
  p_organization_id uuid,
  p_package_id      uuid,
  p_actor_id        uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_reason          text DEFAULT NULL,
  p_undo_batch_id   uuid DEFAULT NULL
)
RETURNS TABLE (ok boolean, undo_batch_id uuid, items_deleted integer, message text)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_pkg public.packages%ROWTYPE;
  v_batch uuid;
  v_ri record;
  v_sub record;
  v_count integer := 0;
BEGIN
  IF NOT public._ops_require_permission(p_actor_id, 'ops.delete_package_cascade') THEN
    RETURN QUERY SELECT false, NULL::uuid, 0, 'permission_denied';
    RETURN;
  END IF;

  SELECT * INTO v_pkg
  FROM public.packages p
  WHERE p.id = p_package_id AND p.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, 0, 'package_not_found';
    RETURN;
  END IF;

  IF v_pkg.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT true, v_pkg.undo_batch_id, 0, 'already_deleted';
    RETURN;
  END IF;

  v_batch := COALESCE(p_undo_batch_id, public._ops_undo_batch_start(p_organization_id, p_actor_id, p_reason));

  PERFORM public._ops_undo_capture(
    p_organization_id, v_batch, 'package', v_pkg.id, to_jsonb(v_pkg),
    jsonb_build_object(
      'pallet_id', v_pkg.pallet_id,
      'id_slip_contents', v_pkg.id_slip_contents,
      'tracking_number', v_pkg.tracking_number,
      'package_code', v_pkg.package_code,
      'slip_contents', public._ops_slip_refs_for_package(v_pkg.id)
    )
  );

  FOR v_ri IN
    SELECT ri.id FROM public.return_items ri
    WHERE ri.organization_id = p_organization_id
      AND ri.package_id = p_package_id
      AND ri.deleted_at IS NULL
  LOOP
    SELECT * INTO v_sub
    FROM public.delete_return_item_with_expected_release(
      p_organization_id, v_ri.id, p_actor_id, NULL, p_reason, v_batch
    ) AS t(ok, undo_batch_id, message);
    IF v_sub.ok THEN v_count := v_count + 1; END IF;
  END LOOP;

  UPDATE public.packages
  SET deleted_at = now(), deleted_by = p_actor_id, undo_batch_id = v_batch, updated_at = now()
  WHERE id = p_package_id;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'package', v_pkg.id, 'cascade_delete_package', p_actor_id, v_batch,
    to_jsonb(v_pkg), NULL, jsonb_build_object('items_deleted', v_count)
  );

  RETURN QUERY SELECT true, v_batch, v_count, 'deleted';
END;
$fn$;

-- ── 10. delete_pallet_cascade ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_pallet_cascade(
  p_organization_id uuid,
  p_pallet_id       uuid,
  p_actor_id        uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_reason          text DEFAULT NULL,
  p_undo_batch_id   uuid DEFAULT NULL
)
RETURNS TABLE (ok boolean, undo_batch_id uuid, packages_deleted integer, items_deleted integer, message text)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_pal public.pallets%ROWTYPE;
  v_batch uuid;
  v_pkg record;
  v_sub record;
  v_orphan record;
  v_pkg_count integer := 0;
  v_item_count integer := 0;
BEGIN
  IF NOT public._ops_require_permission(p_actor_id, 'ops.delete_pallet_cascade') THEN
    RETURN QUERY SELECT false, NULL::uuid, 0, 0, 'permission_denied';
    RETURN;
  END IF;

  SELECT * INTO v_pal
  FROM public.pallets pt
  WHERE pt.id = p_pallet_id AND pt.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, 0, 0, 'pallet_not_found';
    RETURN;
  END IF;

  IF v_pal.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT true, v_pal.undo_batch_id, 0, 0, 'already_deleted';
    RETURN;
  END IF;

  v_batch := COALESCE(p_undo_batch_id, public._ops_undo_batch_start(p_organization_id, p_actor_id, p_reason));

  PERFORM public._ops_undo_capture(
    p_organization_id, v_batch, 'pallet', v_pal.id, to_jsonb(v_pal), '{}'::jsonb
  );

  FOR v_pkg IN
    SELECT p.id FROM public.packages p
    WHERE p.organization_id = p_organization_id
      AND p.pallet_id = p_pallet_id
      AND p.deleted_at IS NULL
  LOOP
    SELECT * INTO v_sub
    FROM public.delete_package_cascade(
      p_organization_id, v_pkg.id, p_actor_id, NULL, p_reason, v_batch
    ) AS t(ok, undo_batch_id, items_deleted, message);
    IF v_sub.ok THEN
      v_pkg_count := v_pkg_count + 1;
      v_item_count := v_item_count + COALESCE(v_sub.items_deleted, 0);
    END IF;
  END LOOP;

  FOR v_orphan IN
    SELECT ri.id FROM public.return_items ri
    WHERE ri.organization_id = p_organization_id
      AND ri.pallet_id = p_pallet_id
      AND ri.package_id IS NULL
      AND ri.deleted_at IS NULL
  LOOP
    PERFORM public.delete_return_item_with_expected_release(
      p_organization_id, v_orphan.id, p_actor_id, NULL, p_reason, v_batch
    );
    v_item_count := v_item_count + 1;
  END LOOP;

  UPDATE public.pallets
  SET deleted_at = now(), deleted_by = p_actor_id, undo_batch_id = v_batch, updated_at = now()
  WHERE id = p_pallet_id;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'pallet', v_pal.id, 'cascade_delete_pallet', p_actor_id, v_batch,
    to_jsonb(v_pal), NULL,
    jsonb_build_object('packages_deleted', v_pkg_count, 'items_deleted', v_item_count)
  );

  RETURN QUERY SELECT true, v_batch, v_pkg_count, v_item_count, 'deleted';
END;
$fn$;

-- ── 11. move_return_item_parent (FIXED move RPC) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.move_return_item_parent(
  p_organization_id       uuid,
  p_return_item_id        uuid,
  p_package_id            uuid DEFAULT NULL,
  p_pallet_id             uuid DEFAULT NULL,
  p_store_id              uuid DEFAULT NULL,
  p_new_receive_scope_key text DEFAULT NULL,
  p_new_tracking_number   text DEFAULT NULL,
  p_actor_id              uuid DEFAULT NULL,
  p_reason                text DEFAULT NULL
)
RETURNS TABLE (ok boolean, undo_batch_id uuid, message text)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_ri public.return_items%ROWTYPE;
  v_batch uuid;
  v_before jsonb;
  v_new_ep uuid;
  v_old_child uuid;
BEGIN
  IF NOT public._ops_require_permission(p_actor_id, 'ops.move_return_item_parent') THEN
    RETURN QUERY SELECT false, NULL::uuid, 'permission_denied';
    RETURN;
  END IF;

  SELECT * INTO v_ri
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id AND ri.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND OR v_ri.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, 'return_item_not_found_or_deleted';
    RETURN;
  END IF;

  v_batch := public._ops_undo_batch_start(p_organization_id, p_actor_id, COALESCE(p_reason, 'move_parent'));
  v_before := to_jsonb(v_ri);

  PERFORM public._ops_undo_capture(
    p_organization_id, v_batch, 'return_item', v_ri.id, v_before,
    jsonb_build_object('package_id', v_ri.package_id, 'pallet_id', v_ri.pallet_id),
    public._ops_expected_allocation_snapshot(v_ri.expected_item_id)
  );

  IF v_ri.package_id IS NOT NULL AND v_ri.package_id IS DISTINCT FROM p_package_id THEN
    UPDATE public.packages SET actual_item_count = greatest(COALESCE(actual_item_count, 0) - 1, 0)
    WHERE id = v_ri.package_id;
  END IF;

  UPDATE public.return_items
  SET package_id = COALESCE(p_package_id, package_id),
      pallet_id = COALESCE(p_pallet_id, pallet_id),
      updated_at = now()
  WHERE id = p_return_item_id
  RETURNING * INTO v_ri;

  IF p_package_id IS NOT NULL THEN
    UPDATE public.packages SET actual_item_count = COALESCE(actual_item_count, 0) + 1
    WHERE id = p_package_id;
  END IF;

  IF v_ri.expected_item_id IS NOT NULL
     AND p_store_id IS NOT NULL
     AND p_new_receive_scope_key IS NOT NULL
     AND trim(p_new_receive_scope_key) <> '' THEN
    SELECT m.new_allocated_expected_package_id, m.old_child_archived_id
    INTO v_new_ep, v_old_child
    FROM public.move_expected_item_unit(
      p_return_item_id,
      p_organization_id,
      p_store_id,
      COALESCE(p_package_id, v_ri.package_id),
      trim(p_new_receive_scope_key),
      v_ri.order_id,
      p_new_tracking_number,
      v_ri.resolved_product_id
    ) m;

    PERFORM public._ops_log_audit_event(
      p_organization_id, 'return_item', v_ri.id, 'expected_move', p_actor_id, v_batch,
      NULL, jsonb_build_object('new_allocated_ep', v_new_ep, 'old_child_archived_id', v_old_child)
    );
  END IF;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'return_item', v_ri.id, 'move_parent', p_actor_id, v_batch,
    v_before, to_jsonb(v_ri)
  );

  RETURN QUERY SELECT true, v_batch, 'moved';
END;
$fn$;

-- ── 12. preview_restore_undo_batch ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_restore_undo_batch(
  p_organization_id uuid,
  p_undo_batch_id   uuid,
  p_actor_id        uuid DEFAULT NULL,
  p_persist_conflicts boolean DEFAULT true
)
RETURNS TABLE (
  can_restore boolean,
  restore_order jsonb,
  conflicts jsonb,
  retention_expires_at timestamptz,
  message text
)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_conflicts jsonb := '[]'::jsonb;
  v_order jsonb := '[]'::jsonb;
  v_blocking integer := 0;
  v_expires timestamptz;
  v_snap record;
  v_lpn text;
  v_tracking text;
  v_parent_deleted boolean;
  v_claim_count integer;
BEGIN
  IF NOT public._ops_require_permission(p_actor_id, 'ops.preview_restore_undo_batch') THEN
    RETURN QUERY SELECT false, '[]'::jsonb, jsonb_build_array(jsonb_build_object('conflict_code','permission_denied')), NULL::timestamptz, 'permission_denied';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.undo_snapshots us
    WHERE us.organization_id = p_organization_id AND us.undo_batch_id = p_undo_batch_id
  ) THEN
    RETURN QUERY SELECT false, '[]'::jsonb, jsonb_build_array(jsonb_build_object('conflict_code','snapshot_not_found')), NULL::timestamptz, 'snapshot_not_found';
    RETURN;
  END IF;

  SELECT MIN(us.expires_at) INTO v_expires
  FROM public.undo_snapshots us
  WHERE us.undo_batch_id = p_undo_batch_id;

  IF v_expires IS NOT NULL AND v_expires < now() THEN
    v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
      'conflict_code', 'retention_expired', 'blocking', true, 'detail', jsonb_build_object('expires_at', v_expires)
    ));
    v_blocking := v_blocking + 1;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('entity_kind', us.entity_kind, 'entity_id', us.entity_id) ORDER BY
    CASE us.entity_kind WHEN 'pallet' THEN 1 WHEN 'package' THEN 2 ELSE 3 END, us.created_at)
  INTO v_order
  FROM public.undo_snapshots us
  WHERE us.undo_batch_id = p_undo_batch_id;

  FOR v_snap IN
    SELECT * FROM public.undo_snapshots us
    WHERE us.organization_id = p_organization_id AND us.undo_batch_id = p_undo_batch_id
  LOOP
    IF v_snap.entity_kind = 'return_item' THEN
      v_lpn := v_snap.row_snapshot ->> 'lpn';
      IF v_lpn IS NOT NULL AND trim(v_lpn) <> '' AND EXISTS (
        SELECT 1 FROM public.return_items ri
        WHERE ri.organization_id = p_organization_id AND ri.lpn = v_lpn
          AND ri.deleted_at IS NULL AND ri.id <> v_snap.entity_id
      ) THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'entity_kind','return_item','entity_id',v_snap.entity_id,'conflict_code','duplicate_lpn','blocking',true
        ));
        v_blocking := v_blocking + 1;
      END IF;

      v_claim_count := public._ops_active_claims_for_return_item(p_organization_id, v_snap.entity_id);
      IF v_claim_count > 0 THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'entity_kind','return_item','entity_id',v_snap.entity_id,'conflict_code','active_claim_submission','blocking',true
        ));
        v_blocking := v_blocking + 1;
      END IF;

      IF (v_snap.row_snapshot ->> 'package_id') IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.packages p
        WHERE p.id = (v_snap.row_snapshot ->> 'package_id')::uuid
          AND p.deleted_at IS NOT NULL
      ) THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'entity_kind','return_item','entity_id',v_snap.entity_id,'conflict_code','parent_missing','blocking',true,
          'detail', jsonb_build_object('parent_kind','package')
        ));
        v_blocking := v_blocking + 1;
      END IF;
    END IF;

    IF v_snap.entity_kind = 'package' THEN
      v_tracking := v_snap.row_snapshot ->> 'tracking_number';
      IF v_tracking IS NOT NULL AND trim(v_tracking) <> '' AND EXISTS (
        SELECT 1 FROM public.packages p
        WHERE p.organization_id = p_organization_id AND p.tracking_number = v_tracking
          AND p.deleted_at IS NULL AND p.id <> v_snap.entity_id
      ) THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'entity_kind','package','entity_id',v_snap.entity_id,'conflict_code','duplicate_tracking','blocking',true
        ));
        v_blocking := v_blocking + 1;
      END IF;

      IF (v_snap.row_snapshot ->> 'pallet_id') IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.pallets pt
        WHERE pt.id = (v_snap.row_snapshot ->> 'pallet_id')::uuid AND pt.deleted_at IS NOT NULL
      ) THEN
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'entity_kind','package','entity_id',v_snap.entity_id,'conflict_code','parent_missing','blocking',true,
          'detail', jsonb_build_object('parent_kind','pallet')
        ));
        v_blocking := v_blocking + 1;
      END IF;
    END IF;
  END LOOP;

  IF p_persist_conflicts AND jsonb_array_length(v_conflicts) > 0 THEN
    INSERT INTO public.restore_conflicts (organization_id, undo_batch_id, entity_kind, entity_id, conflict_code, conflict_detail, blocking)
    SELECT p_organization_id, p_undo_batch_id,
      (c->>'entity_kind')::text,
      (c->>'entity_id')::uuid,
      c->>'conflict_code',
      COALESCE(c->'detail', '{}'::jsonb),
      COALESCE((c->>'blocking')::boolean, true)
    FROM jsonb_array_elements(v_conflicts) c
    ON CONFLICT DO NOTHING;
  END IF;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'batch', p_undo_batch_id, 'restore_preview', p_actor_id, p_undo_batch_id,
    NULL, jsonb_build_object('blocking_count', v_blocking), jsonb_build_object('conflicts', v_conflicts)
  );

  RETURN QUERY SELECT (v_blocking = 0), COALESCE(v_order, '[]'::jsonb), v_conflicts, v_expires,
    CASE WHEN v_blocking = 0 THEN 'preview_ok' ELSE 'conflicts_present' END;
END;
$fn$;

-- ── 13. apply_restore_undo_batch ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_restore_undo_batch(
  p_organization_id uuid,
  p_undo_batch_id   uuid,
  p_actor_id        uuid DEFAULT NULL,
  p_confirm         boolean DEFAULT false,
  p_force           boolean DEFAULT false
)
RETURNS TABLE (ok boolean, restored jsonb, message text)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_preview record;
  v_snap record;
  v_restored jsonb := '{"pallet":0,"package":0,"return_item":0}'::jsonb;
  v_ep_id uuid;
  v_alloc jsonb;
BEGIN
  IF NOT p_confirm THEN
    RETURN QUERY SELECT false, v_restored, 'confirm_required';
    RETURN;
  END IF;

  IF NOT public._ops_require_permission(p_actor_id, 'ops.apply_restore_undo_batch') THEN
    RETURN QUERY SELECT false, v_restored, 'permission_denied';
    RETURN;
  END IF;

  SELECT * INTO v_preview
  FROM public.preview_restore_undo_batch(p_organization_id, p_undo_batch_id, p_actor_id, false) pr
  LIMIT 1;

  IF NOT v_preview.can_restore AND NOT p_force THEN
    RETURN QUERY SELECT false, v_restored, 'conflicts_present';
    RETURN;
  END IF;

  FOR v_snap IN
    SELECT * FROM public.undo_snapshots us
    WHERE us.organization_id = p_organization_id AND us.undo_batch_id = p_undo_batch_id
      AND us.entity_kind = 'pallet'
    ORDER BY us.created_at
  LOOP
    UPDATE public.pallets SET deleted_at = NULL, deleted_by = NULL, undo_batch_id = NULL, updated_at = now()
    WHERE id = v_snap.entity_id;
    v_restored := jsonb_set(v_restored, '{pallet}', to_jsonb((v_restored->>'pallet')::int + 1));
  END LOOP;

  FOR v_snap IN
    SELECT * FROM public.undo_snapshots us
    WHERE us.organization_id = p_organization_id AND us.undo_batch_id = p_undo_batch_id
      AND us.entity_kind = 'package'
    ORDER BY us.created_at
  LOOP
    UPDATE public.packages SET deleted_at = NULL, deleted_by = NULL, undo_batch_id = NULL, updated_at = now()
    WHERE id = v_snap.entity_id;
    v_restored := jsonb_set(v_restored, '{package}', to_jsonb((v_restored->>'package')::int + 1));
  END LOOP;

  FOR v_snap IN
    SELECT * FROM public.undo_snapshots us
    WHERE us.organization_id = p_organization_id AND us.undo_batch_id = p_undo_batch_id
      AND us.entity_kind = 'return_item'
    ORDER BY us.created_at
  LOOP
    UPDATE public.return_items
    SET deleted_at = NULL, deleted_by = NULL, undo_batch_id = NULL,
        package_id = (v_snap.row_snapshot ->> 'package_id')::uuid,
        pallet_id = (v_snap.row_snapshot ->> 'pallet_id')::uuid,
        updated_at = now()
    WHERE id = v_snap.entity_id;

    v_alloc := v_snap.expected_allocation;
    IF v_alloc IS NOT NULL AND (v_alloc->>'expected_item_id') IS NOT NULL THEN
      v_ep_id := (v_alloc->>'expected_item_id')::uuid;
      IF EXISTS (SELECT 1 FROM public.expected_packages ep WHERE ep.id = v_ep_id) THEN
        UPDATE public.return_items SET expected_item_id = v_ep_id WHERE id = v_snap.entity_id;
      ELSE
        INSERT INTO public.restore_conflicts (
          organization_id, undo_batch_id, entity_kind, entity_id, conflict_code, blocking
        ) VALUES (
          p_organization_id, p_undo_batch_id, 'return_item', v_snap.entity_id, 'allocation_conflict', false
        );
      END IF;
    END IF;

    v_restored := jsonb_set(v_restored, '{return_item}', to_jsonb((v_restored->>'return_item')::int + 1));
  END LOOP;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'batch', p_undo_batch_id, 'restore_apply', p_actor_id, p_undo_batch_id,
    NULL, v_restored, jsonb_build_object('force', p_force)
  );

  RETURN QUERY SELECT true, v_restored, 'restored';
END;
$fn$;

-- ── 14. restore_deleted_entity (single-entity; parent checks) ────────────────
CREATE OR REPLACE FUNCTION public.restore_deleted_entity(
  p_organization_id uuid,
  p_undo_batch_id   uuid,
  p_entity_kind     text,
  p_entity_id       uuid,
  p_actor_id        uuid DEFAULT NULL,
  p_force           boolean DEFAULT false
)
RETURNS TABLE (ok boolean, message text, conflicts jsonb)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_preview record;
BEGIN
  IF NOT public._ops_require_permission(p_actor_id, 'ops.restore_deleted_entity') THEN
    RETURN QUERY SELECT false, 'permission_denied', '[]'::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_preview
  FROM public.preview_restore_undo_batch(p_organization_id, p_undo_batch_id, p_actor_id, true) LIMIT 1;

  IF NOT v_preview.can_restore AND NOT p_force THEN
    RETURN QUERY SELECT false, 'conflicts', v_preview.conflicts;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT ar.ok, ar.message, COALESCE(v_preview.conflicts, '[]'::jsonb)
  FROM public.apply_restore_undo_batch(p_organization_id, p_undo_batch_id, p_actor_id, true, p_force) ar;
END;
$fn$;

-- ── 15. Grants ───────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.delete_return_item_with_expected_release(uuid, uuid, uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_package_cascade(uuid, uuid, uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_pallet_cascade(uuid, uuid, uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.move_return_item_parent(uuid, uuid, uuid, uuid, uuid, text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.preview_restore_undo_batch(uuid, uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_restore_undo_batch(uuid, uuid, uuid, boolean, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_deleted_entity(uuid, uuid, text, uuid, uuid, boolean) TO service_role;

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.undo_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restore_conflicts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_events_org_select ON public.audit_events;
CREATE POLICY audit_events_org_select ON public.audit_events
  FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid()
  ));

DROP POLICY IF EXISTS undo_snapshots_org_select ON public.undo_snapshots;
CREATE POLICY undo_snapshots_org_select ON public.undo_snapshots
  FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid()
  ));

DROP POLICY IF EXISTS restore_conflicts_org_select ON public.restore_conflicts;
CREATE POLICY restore_conflicts_org_select ON public.restore_conflicts
  FOR SELECT TO authenticated
  USING (organization_id IN (
    SELECT p.organization_id FROM public.profiles p WHERE p.id = auth.uid()
  ));

GRANT SELECT ON public.audit_events TO authenticated;
GRANT SELECT ON public.undo_snapshots TO authenticated;
GRANT SELECT ON public.restore_conflicts TO authenticated;
GRANT ALL ON public.audit_events TO service_role;
GRANT ALL ON public.undo_snapshots TO service_role;
GRANT ALL ON public.restore_conflicts TO service_role;

COMMIT;
