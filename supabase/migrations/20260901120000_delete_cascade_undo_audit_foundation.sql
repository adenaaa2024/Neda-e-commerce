-- =============================================================================
-- SUPERSEDED — DO NOT APPLY. Wrong release/move_expected_item_unit call signatures.
-- Use: supabase/migrations/20260903120000_delete_cascade_undo_audit_foundation_v2.sql
-- DELETE CASCADE + UNDO AUDIT FOUNDATION (DRAFT — do not apply without approval)
-- Prerequisite: DELETE CASCADE + UNDO AUDIT ARCHITECTURE PLAN
-- Integrates: release_expected_item_unit / move_expected_item_unit (item-level split)
-- Policy: soft-delete only on pallets / packages / return_items; no package_items
-- Apply: staging only when APPROVED_DELETE_CASCADE_UNDO_AUDIT_MIGRATION=true
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
  'Links soft-delete to undo_snapshots / restore_deleted_entity batch.';
COMMENT ON COLUMN public.packages.undo_batch_id IS
  'Links soft-delete to undo_snapshots / restore_deleted_entity batch.';
COMMENT ON COLUMN public.return_items.undo_batch_id IS
  'Links soft-delete to undo_snapshots / restore_deleted_entity batch.';

-- ── 3. audit_events (unified operational audit) ─────────────────────────────
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
    entity_kind IN ('pallet', 'package', 'return_item')
  ),
  CONSTRAINT audit_events_action_chk CHECK (
    action IN (
      'soft_delete',
      'restore',
      'move_parent',
      'cascade_delete_pallet',
      'cascade_delete_package',
      'delete_return_item',
      'expected_release',
      'expected_move'
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

COMMENT ON TABLE public.audit_events IS
  'Append-only operational delete/move/restore audit; complements legacy return_audit_log.';

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

COMMENT ON TABLE public.undo_snapshots IS
  'Point-in-time row snapshots for restore_deleted_entity; expected_allocation stores EP id + qty for item-level split.';

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
      'expected_root_qty_insufficient',
      'parent_still_deleted',
      'permission_denied',
      'retention_expired'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_restore_conflicts_batch
  ON public.restore_conflicts (undo_batch_id, blocking);

-- ── 6. Permissions (additive seeds) ────────────────────────────────────────────
INSERT INTO public.permissions (key, name, module, description)
VALUES
  ('ops.delete_pallet_cascade', 'Delete pallet (cascade)', 'operations',
   'Soft-delete pallet and contained packages/return_items with undo batch'),
  ('ops.delete_package_cascade', 'Delete package (cascade)', 'operations',
   'Soft-delete package and return_items with undo batch'),
  ('ops.delete_return_item', 'Delete return item', 'operations',
   'Soft-delete return_item; releases item-level expected allocation'),
  ('ops.move_return_item_parent', 'Move return item parent', 'operations',
   'Reassign package/pallet; may move_expected_item_unit when allocated'),
  ('ops.restore_deleted_entity', 'Restore deleted entity', 'operations',
   'Restore from undo_snapshots for undo_batch_id'),
  ('ops.view_undo_history', 'View undo history', 'operations',
   'Read audit_events and undo_snapshots for org')
ON CONFLICT (key) DO NOTHING;

-- ── 7. Internal helpers ──────────────────────────────────────────────────────
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
    p_organization_id, 'pallet', v_batch, 'cascade_delete_pallet', p_actor_id,
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
  WHERE us.undo_batch_id = p_undo_batch_id
  LIMIT 1;

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

-- ── 8. delete_return_item_with_expected_release ─────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_return_item_with_expected_release(
  p_organization_id uuid,
  p_return_item_id  uuid,
  p_actor_id        uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_reason          text DEFAULT NULL,
  p_undo_batch_id   uuid DEFAULT NULL
)
RETURNS TABLE (
  ok boolean,
  undo_batch_id uuid,
  message text
)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_ri public.return_items%ROWTYPE;
  v_batch uuid;
  v_rel record;
  v_claim_count integer;
BEGIN
  IF NOT public._ops_require_permission(p_actor_id, 'ops.delete_return_item') THEN
    RETURN QUERY SELECT false, NULL::uuid, 'permission_denied';
    RETURN;
  END IF;

  IF p_idempotency_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.audit_events ae
    WHERE ae.organization_id = p_organization_id
      AND ae.idempotency_key = p_idempotency_key
  ) THEN
    SELECT ae.undo_batch_id INTO v_batch
    FROM public.audit_events ae
    WHERE ae.organization_id = p_organization_id
      AND ae.idempotency_key = p_idempotency_key
    LIMIT 1;
    RETURN QUERY SELECT true, v_batch, 'idempotent_replay';
    RETURN;
  END IF;

  SELECT * INTO v_ri
  FROM public.return_items ri
  WHERE ri.id = p_return_item_id
    AND ri.organization_id = p_organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, 'return_item_not_found';
    RETURN;
  END IF;

  IF v_ri.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT true, v_ri.undo_batch_id, 'already_deleted';
    RETURN;
  END IF;

  SELECT count(*)::integer INTO v_claim_count
  FROM public.claim_submissions cs
  WHERE cs.return_id = p_return_item_id
    AND cs.status NOT IN ('dismissed', 'rejected', 'closed');

  IF v_claim_count > 0 THEN
    RETURN QUERY SELECT false, NULL::uuid, 'active_claim_submission';
    RETURN;
  END IF;

  v_batch := COALESCE(p_undo_batch_id, public._ops_undo_batch_start(p_organization_id, p_actor_id, p_reason));

  PERFORM public._ops_undo_capture(
    p_organization_id, v_batch, 'return_item', v_ri.id,
    to_jsonb(v_ri),
    jsonb_build_object('package_id', v_ri.package_id, 'pallet_id', v_ri.pallet_id),
    CASE WHEN v_ri.expected_item_id IS NOT NULL THEN
      jsonb_build_object('expected_item_id', v_ri.expected_item_id)
    ELSE NULL END
  );

  IF v_ri.expected_item_id IS NOT NULL THEN
    SELECT * INTO v_rel
    FROM public.release_expected_item_unit(p_organization_id, p_return_item_id) AS t(ok, message);
    PERFORM public._ops_log_audit_event(
      p_organization_id, 'return_item', v_ri.id, 'expected_release', p_actor_id, v_batch,
      NULL, jsonb_build_object('ok', v_rel.ok, 'message', v_rel.message)
    );
    IF NOT v_rel.ok THEN
      RETURN QUERY SELECT false, v_batch, v_rel.message;
      RETURN;
    END IF;
  END IF;

  UPDATE public.return_items
  SET deleted_at = now(),
      deleted_by = p_actor_id,
      undo_batch_id = v_batch,
      updated_at = now()
  WHERE id = p_return_item_id;

  IF v_ri.package_id IS NOT NULL THEN
    UPDATE public.packages
    SET actual_item_count = greatest(actual_item_count - 1, 0),
        updated_at = now()
    WHERE id = v_ri.package_id;
  END IF;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'return_item', v_ri.id, 'delete_return_item', p_actor_id, v_batch,
    to_jsonb(v_ri), NULL,
    jsonb_build_object('reason', p_reason, 'idempotency_key', p_idempotency_key)
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
  v_count integer := 0;
  v_sub record;
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
    jsonb_build_object('pallet_id', v_pkg.pallet_id)
  );

  FOR v_ri IN
    SELECT ri.id
    FROM public.return_items ri
    WHERE ri.organization_id = p_organization_id
      AND ri.package_id = p_package_id
      AND ri.deleted_at IS NULL
  LOOP
    SELECT * INTO v_sub
    FROM public.delete_return_item_with_expected_release(
      p_organization_id, v_ri.id, p_actor_id, NULL, p_reason, v_batch
    ) AS t(ok, undo_batch_id, message);
    IF v_sub.ok THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  UPDATE public.packages
  SET deleted_at = now(),
      deleted_by = p_actor_id,
      undo_batch_id = v_batch,
      updated_at = now()
  WHERE id = p_package_id;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'package', v_pkg.id, 'cascade_delete_package', p_actor_id, v_batch,
    to_jsonb(v_pkg), NULL, jsonb_build_object('items_deleted', v_count)
  );

  RETURN QUERY SELECT true, v_batch, v_count, 'deleted';
END;
$fn$;

-- ── 10. delete_pallet_cascade ──────────────────────────────────────────────────
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
    SELECT p.id
    FROM public.packages p
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

  FOR v_sub IN
    SELECT ri.id
    FROM public.return_items ri
    WHERE ri.organization_id = p_organization_id
      AND ri.pallet_id = p_pallet_id
      AND ri.package_id IS NULL
      AND ri.deleted_at IS NULL
  LOOP
    PERFORM public.delete_return_item_with_expected_release(
      p_organization_id, v_sub.id, p_actor_id, NULL, p_reason, v_batch
    );
    v_item_count := v_item_count + 1;
  END LOOP;

  UPDATE public.pallets
  SET deleted_at = now(),
      deleted_by = p_actor_id,
      undo_batch_id = v_batch,
      updated_at = now()
  WHERE id = p_pallet_id;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'pallet', v_pal.id, 'cascade_delete_pallet', p_actor_id, v_batch,
    to_jsonb(v_pal), NULL,
    jsonb_build_object('packages_deleted', v_pkg_count, 'items_deleted', v_item_count)
  );

  RETURN QUERY SELECT true, v_batch, v_pkg_count, v_item_count, 'deleted';
END;
$fn$;

-- ── 11. move_return_item_parent ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.move_return_item_parent(
  p_organization_id uuid,
  p_return_item_id  uuid,
  p_package_id      uuid DEFAULT NULL,
  p_pallet_id       uuid DEFAULT NULL,
  p_store_id        uuid DEFAULT NULL,
  p_actor_id        uuid DEFAULT NULL,
  p_entity_type     text DEFAULT NULL,
  p_id_slip_contents text DEFAULT NULL
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
  v_move record;
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

  v_batch := public._ops_undo_batch_start(p_organization_id, p_actor_id, 'move_parent');
  v_before := to_jsonb(v_ri);

  PERFORM public._ops_undo_capture(
    p_organization_id, v_batch, 'return_item', v_ri.id, v_before,
    jsonb_build_object('package_id', v_ri.package_id, 'pallet_id', v_ri.pallet_id)
  );

  IF v_ri.package_id IS NOT NULL AND v_ri.package_id IS DISTINCT FROM p_package_id THEN
    UPDATE public.packages SET actual_item_count = greatest(actual_item_count - 1, 0) WHERE id = v_ri.package_id;
  END IF;

  UPDATE public.return_items
  SET package_id = p_package_id,
      pallet_id = p_pallet_id,
      updated_at = now()
  WHERE id = p_return_item_id
  RETURNING * INTO v_ri;

  IF p_package_id IS NOT NULL THEN
    UPDATE public.packages SET actual_item_count = actual_item_count + 1 WHERE id = p_package_id;
  END IF;

  IF v_ri.expected_item_id IS NOT NULL AND p_store_id IS NOT NULL THEN
    SELECT * INTO v_move
    FROM public.move_expected_item_unit(
      p_organization_id, p_store_id, p_return_item_id,
      p_entity_type, p_id_slip_contents, p_package_id, p_pallet_id
    ) AS t(allocated_ep_id, parent_ep_id, remainder_qty, overage_qty, ok, message);
    PERFORM public._ops_log_audit_event(
      p_organization_id, 'return_item', v_ri.id, 'expected_move', p_actor_id, v_batch,
      NULL, jsonb_build_object('ok', v_move.ok, 'message', v_move.message)
    );
    IF NOT v_move.ok THEN
      RETURN QUERY SELECT false, v_batch, v_move.message;
      RETURN;
    END IF;
  END IF;

  PERFORM public._ops_log_audit_event(
    p_organization_id, 'return_item', v_ri.id, 'move_parent', p_actor_id, v_batch,
    v_before, to_jsonb(v_ri)
  );

  RETURN QUERY SELECT true, v_batch, 'moved';
END;
$fn$;

-- ── 12. restore_deleted_entity ────────────────────────────────────────────────
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
  v_snap public.undo_snapshots%ROWTYPE;
  v_conflicts jsonb := '[]'::jsonb;
  v_lpn text;
  v_tracking text;
  v_claim_count integer;
BEGIN
  IF NOT public._ops_require_permission(p_actor_id, 'ops.restore_deleted_entity') THEN
    RETURN QUERY SELECT false, 'permission_denied', '[]'::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_snap
  FROM public.undo_snapshots us
  WHERE us.organization_id = p_organization_id
    AND us.undo_batch_id = p_undo_batch_id
    AND us.entity_kind = p_entity_kind
    AND us.entity_id = p_entity_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'snapshot_not_found', '[]'::jsonb;
    RETURN;
  END IF;

  IF v_snap.expires_at IS NOT NULL AND v_snap.expires_at < now() AND NOT p_force THEN
    INSERT INTO public.restore_conflicts (
      organization_id, undo_batch_id, entity_kind, entity_id,
      conflict_code, conflict_detail
    )
    VALUES (
      p_organization_id, p_undo_batch_id, p_entity_kind, p_entity_id,
      'retention_expired', jsonb_build_object('expires_at', v_snap.expires_at)
    );
    RETURN QUERY SELECT false, 'retention_expired', v_conflicts;
    RETURN;
  END IF;

  IF p_entity_kind = 'return_item' THEN
    v_lpn := v_snap.row_snapshot ->> 'lpn';
    IF v_lpn IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.return_items ri
      WHERE ri.organization_id = p_organization_id
        AND ri.lpn = v_lpn
        AND ri.deleted_at IS NULL
        AND ri.id <> p_entity_id
    ) THEN
      INSERT INTO public.restore_conflicts (
        organization_id, undo_batch_id, entity_kind, entity_id, conflict_code
      )
      VALUES (p_organization_id, p_undo_batch_id, p_entity_kind, p_entity_id, 'duplicate_lpn');
      v_conflicts := v_conflicts || jsonb_build_array('duplicate_lpn');
    END IF;

    SELECT count(*)::integer INTO v_claim_count
    FROM public.claim_submissions cs
    WHERE cs.return_id = p_entity_id
      AND cs.status NOT IN ('dismissed', 'rejected', 'closed');

    IF v_claim_count > 0 THEN
      INSERT INTO public.restore_conflicts (
        organization_id, undo_batch_id, entity_kind, entity_id, conflict_code
      )
      VALUES (p_organization_id, p_undo_batch_id, p_entity_kind, p_entity_id, 'active_claim_submission');
      v_conflicts := v_conflicts || jsonb_build_array('active_claim_submission');
    END IF;

    IF jsonb_array_length(v_conflicts) > 0 AND NOT p_force THEN
      RETURN QUERY SELECT false, 'conflicts', v_conflicts;
      RETURN;
    END IF;

    UPDATE public.return_items
    SET deleted_at = NULL,
        deleted_by = NULL,
        undo_batch_id = NULL,
        package_id = (v_snap.row_snapshot ->> 'package_id')::uuid,
        pallet_id = (v_snap.row_snapshot ->> 'pallet_id')::uuid,
        updated_at = now()
    WHERE id = p_entity_id;

    -- Item-level EP re-allocate deferred: operator must re-receive or run allocate_expected_item_unit
    -- when expected_allocation present in snapshot (logged in audit metadata).

    PERFORM public._ops_log_audit_event(
      p_organization_id, 'return_item', p_entity_id, 'restore', p_actor_id, p_undo_batch_id,
      v_snap.row_snapshot, NULL,
      jsonb_build_object(
        'expected_allocation', v_snap.expected_allocation,
        'note', 'EP re-link requires manual receive or allocate_expected_item_unit if needed'
      )
    );

    RETURN QUERY SELECT true, 'restored', v_conflicts;
    RETURN;
  END IF;

  IF p_entity_kind = 'package' THEN
    v_tracking := v_snap.row_snapshot ->> 'tracking_number';
    IF v_tracking IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.packages p
      WHERE p.organization_id = p_organization_id
        AND p.tracking_number = v_tracking
        AND p.deleted_at IS NULL
        AND p.id <> p_entity_id
    ) THEN
      RETURN QUERY SELECT false, 'duplicate_tracking', jsonb_build_array('duplicate_tracking');
      RETURN;
    END IF;
    UPDATE public.packages
    SET deleted_at = NULL, deleted_by = NULL, undo_batch_id = NULL, updated_at = now()
    WHERE id = p_entity_id;
    PERFORM public._ops_log_audit_event(
      p_organization_id, 'package', p_entity_id, 'restore', p_actor_id, p_undo_batch_id,
      v_snap.row_snapshot, NULL, '{}'::jsonb
    );
    RETURN QUERY SELECT true, 'restored', '[]'::jsonb;
    RETURN;
  END IF;

  IF p_entity_kind = 'pallet' THEN
    UPDATE public.pallets
    SET deleted_at = NULL, deleted_by = NULL, undo_batch_id = NULL, updated_at = now()
    WHERE id = p_entity_id;
    PERFORM public._ops_log_audit_event(
      p_organization_id, 'pallet', p_entity_id, 'restore', p_actor_id, p_undo_batch_id,
      v_snap.row_snapshot, NULL, '{}'::jsonb
    );
    RETURN QUERY SELECT true, 'restored', '[]'::jsonb;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, 'unsupported_entity_kind', '[]'::jsonb;
END;
$fn$;

-- ── 13. Grants (service_role + authenticated execute when RLS wired) ───────────
GRANT EXECUTE ON FUNCTION public.delete_return_item_with_expected_release(uuid, uuid, uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_package_cascade(uuid, uuid, uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_pallet_cascade(uuid, uuid, uuid, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.move_return_item_parent(uuid, uuid, uuid, uuid, uuid, uuid, text, text) TO service_role;
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
