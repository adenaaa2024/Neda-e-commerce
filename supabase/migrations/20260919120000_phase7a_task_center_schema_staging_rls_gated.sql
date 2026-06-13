-- =============================================================================
-- PHASE-7A — Task Center schema (staging apply; RLS hard-gated)
--
-- Creates: task_items, task_comments, task_watchers, task_activity_log
-- Alters:  groups.group_type, groups.parent_group_id
--
-- Guarantees:
--   * RLS enabled in same transaction as CREATE TABLE
--   * service_role ALL; authenticated SELECT only (org-scoped)
--   * Child SELECT via EXISTS join to task_items.organization_id
--   * No authenticated INSERT/UPDATE/DELETE policies (Phase 7A)
--   * No seed data; no scanner / platform access code changes
--   * Reuses groups spine — no teams/departments/task_assignments tables
-- =============================================================================

BEGIN;

-- ── 1) groups hierarchy columns (additive) ────────────────────────────────────

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS group_type text NOT NULL DEFAULT 'access_group';

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS parent_group_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.groups'::regclass
      AND conname = 'groups_group_type_check'
  ) THEN
    ALTER TABLE public.groups
      ADD CONSTRAINT groups_group_type_check
      CHECK (group_type IN ('access_group', 'team', 'department', 'queue'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.groups'::regclass
      AND conname = 'groups_parent_group_id_fkey'
  ) THEN
    ALTER TABLE public.groups
      ADD CONSTRAINT groups_parent_group_id_fkey
      FOREIGN KEY (parent_group_id)
      REFERENCES public.groups (id)
      ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.groups.group_type IS
  'Task Center org spine: access_group | team | department | queue. Reuses groups — no separate teams/departments tables.';

COMMENT ON COLUMN public.groups.parent_group_id IS
  'Optional hierarchy parent within the same tenant groups catalog.';

CREATE INDEX IF NOT EXISTS idx_groups_org_group_type
  ON public.groups (organization_id, group_type);

CREATE INDEX IF NOT EXISTS idx_groups_parent_group_id
  ON public.groups (parent_group_id)
  WHERE parent_group_id IS NOT NULL;

-- ── 2) task_items ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.task_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.organizations (id) ON DELETE CASCADE,
  store_id uuid NULL
    REFERENCES public.stores (id) ON DELETE SET NULL,
  title text NOT NULL,
  description text NULL,
  status text NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'normal',
  source_module text NULL,
  source_entity_type text NULL,
  source_entity_id text NULL,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  assigned_user_id uuid NULL
    REFERENCES public.profiles (id) ON DELETE SET NULL,
  assigned_group_id uuid NULL
    REFERENCES public.groups (id) ON DELETE SET NULL,
  created_by uuid NULL
    REFERENCES public.profiles (id) ON DELETE SET NULL,
  due_at timestamptz NULL,
  completed_at timestamptz NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL,
  CONSTRAINT task_items_status_check CHECK (status IN (
    'open',
    'in_progress',
    'blocked',
    'waiting',
    'completed',
    'canceled',
    'archived'
  )),
  CONSTRAINT task_items_priority_check CHECK (priority IN (
    'low',
    'normal',
    'high',
    'urgent'
  )),
  CONSTRAINT task_items_source_module_check CHECK (
    source_module IS NULL OR source_module IN (
      'scanner',
      'claims',
      'product',
      'automation',
      'warehouse',
      'master_data',
      'platform'
    )
  )
);

COMMENT ON TABLE public.task_items IS
  'Task Center work units. Phase 7A: schema + RLS only; server/service_role writes; no client mutations.';

COMMENT ON COLUMN public.task_items.source_module IS
  'Origin module key. scanner allowed for future scanner bridge (deferred — no auto-seed in 7A).';

COMMENT ON COLUMN public.task_items.source_entity_type IS
  'Polymorphic source type. Scanner examples: return_item, package, pallet, shipment_review, box_review, '
  'pallet_review, scan_problem, missing_review, damaged_item, over_received, unexpected_item, photo_missing, operator_correction.';

COMMENT ON COLUMN public.task_items.source_entity_id IS
  'Polymorphic source id (text for uuid and composite keys).';

COMMENT ON COLUMN public.task_items.source_snapshot IS
  'Frozen read-model context for Task Center UI; not source of truth for domain entities.';

CREATE INDEX IF NOT EXISTS idx_task_items_organization_id
  ON public.task_items (organization_id);

CREATE INDEX IF NOT EXISTS idx_task_items_store_id
  ON public.task_items (organization_id, store_id);

CREATE INDEX IF NOT EXISTS idx_task_items_assigned_user_id
  ON public.task_items (organization_id, assigned_user_id)
  WHERE assigned_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_items_assigned_group_id
  ON public.task_items (organization_id, assigned_group_id)
  WHERE assigned_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_items_status
  ON public.task_items (organization_id, status);

CREATE INDEX IF NOT EXISTS idx_task_items_source
  ON public.task_items (organization_id, source_module, source_entity_type, source_entity_id);

CREATE INDEX IF NOT EXISTS idx_task_items_due_at
  ON public.task_items (organization_id, due_at)
  WHERE due_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_items_deleted_at
  ON public.task_items (organization_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_items_active_source_identity
  ON public.task_items (organization_id, source_module, source_entity_type, source_entity_id)
  WHERE deleted_at IS NULL
    AND source_module IS NOT NULL
    AND source_entity_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_task_items_set_updated_at ON public.task_items;
CREATE TRIGGER trg_task_items_set_updated_at
  BEFORE UPDATE ON public.task_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ── 3) task_comments ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL
    REFERENCES public.task_items (id) ON DELETE CASCADE,
  author_user_id uuid NULL
    REFERENCES public.profiles (id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

COMMENT ON TABLE public.task_comments IS
  'Task Center comment thread. Phase 7A: SELECT only for authenticated; writes via service_role.';

CREATE INDEX IF NOT EXISTS idx_task_comments_task_id
  ON public.task_comments (task_id);

DROP TRIGGER IF EXISTS trg_task_comments_set_updated_at ON public.task_comments;
CREATE TRIGGER trg_task_comments_set_updated_at
  BEFORE UPDATE ON public.task_comments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ── 4) task_watchers ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.task_watchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL
    REFERENCES public.task_items (id) ON DELETE CASCADE,
  profile_id uuid NOT NULL
    REFERENCES public.profiles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_watchers_task_profile_unique UNIQUE (task_id, profile_id)
);

COMMENT ON TABLE public.task_watchers IS
  'Task Center followers/watchers. Phase 7A: SELECT only for authenticated; writes via service_role.';

CREATE INDEX IF NOT EXISTS idx_task_watchers_task_id
  ON public.task_watchers (task_id);

-- ── 5) task_activity_log ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.task_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL
    REFERENCES public.task_items (id) ON DELETE CASCADE,
  actor_user_id uuid NULL
    REFERENCES public.profiles (id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_activity_log_event_type_check CHECK (event_type IN (
    'created',
    'status_changed',
    'priority_changed',
    'assigned',
    'unassigned',
    'group_assigned',
    'group_unassigned',
    'due_date_changed',
    'blocked',
    'unblocked',
    'comment_added',
    'watcher_added',
    'watcher_removed',
    'completed',
    'canceled',
    'archived',
    'source_linked'
  ))
);

COMMENT ON TABLE public.task_activity_log IS
  'Append-only Task Center activity log. Phase 7A: SELECT only for authenticated; writes via service_role.';

CREATE INDEX IF NOT EXISTS idx_task_activity_log_task_id
  ON public.task_activity_log (task_id, created_at DESC);

-- ── 6) RLS hard gate (same transaction) ───────────────────────────────────────

ALTER TABLE public.task_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_watchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_activity_log ENABLE ROW LEVEL SECURITY;

-- task_items
DROP POLICY IF EXISTS task_items_service_role_all ON public.task_items;
CREATE POLICY task_items_service_role_all
  ON public.task_items
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS task_items_select_own_org ON public.task_items;
CREATE POLICY task_items_select_own_org
  ON public.task_items
  FOR SELECT
  TO authenticated
  USING (organization_id = public.get_my_organization_id());

-- task_comments (org scope via parent task)
DROP POLICY IF EXISTS task_comments_service_role_all ON public.task_comments;
CREATE POLICY task_comments_service_role_all
  ON public.task_comments
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS task_comments_select_own_org ON public.task_comments;
CREATE POLICY task_comments_select_own_org
  ON public.task_comments
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.task_items ti
      WHERE ti.id = task_comments.task_id
        AND ti.organization_id = public.get_my_organization_id()
    )
  );

-- task_watchers
DROP POLICY IF EXISTS task_watchers_service_role_all ON public.task_watchers;
CREATE POLICY task_watchers_service_role_all
  ON public.task_watchers
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS task_watchers_select_own_org ON public.task_watchers;
CREATE POLICY task_watchers_select_own_org
  ON public.task_watchers
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.task_items ti
      WHERE ti.id = task_watchers.task_id
        AND ti.organization_id = public.get_my_organization_id()
    )
  );

-- task_activity_log
DROP POLICY IF EXISTS task_activity_log_service_role_all ON public.task_activity_log;
CREATE POLICY task_activity_log_service_role_all
  ON public.task_activity_log
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS task_activity_log_select_own_org ON public.task_activity_log;
CREATE POLICY task_activity_log_select_own_org
  ON public.task_activity_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.task_items ti
      WHERE ti.id = task_activity_log.task_id
        AND ti.organization_id = public.get_my_organization_id()
    )
  );

-- ── 7) Grants (no anon/public) ────────────────────────────────────────────────

REVOKE ALL ON public.task_items FROM PUBLIC, anon;
REVOKE ALL ON public.task_comments FROM PUBLIC, anon;
REVOKE ALL ON public.task_watchers FROM PUBLIC, anon;
REVOKE ALL ON public.task_activity_log FROM PUBLIC, anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_items TO service_role;
GRANT SELECT ON public.task_items TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_comments TO service_role;
GRANT SELECT ON public.task_comments TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_watchers TO service_role;
GRANT SELECT ON public.task_watchers TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_activity_log TO service_role;
GRANT SELECT ON public.task_activity_log TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
