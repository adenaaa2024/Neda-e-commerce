-- =============================================================================
-- ROLLBACK — PHASE-7A Task Center schema (staging only)
-- Drops objects created by 20260919120000_phase7a_task_center_schema_staging_rls_gated.sql
-- Does NOT touch existing group memberships, permissions, or unrelated groups data.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.task_activity_log CASCADE;
DROP TABLE IF EXISTS public.task_watchers CASCADE;
DROP TABLE IF EXISTS public.task_comments CASCADE;
DROP TABLE IF EXISTS public.task_items CASCADE;

ALTER TABLE public.groups DROP CONSTRAINT IF EXISTS groups_parent_group_id_fkey;
ALTER TABLE public.groups DROP CONSTRAINT IF EXISTS groups_group_type_check;

DROP INDEX IF EXISTS public.idx_groups_parent_group_id;
DROP INDEX IF EXISTS public.idx_groups_org_group_type;

ALTER TABLE public.groups DROP COLUMN IF EXISTS parent_group_id;
ALTER TABLE public.groups DROP COLUMN IF EXISTS group_type;

COMMIT;

NOTIFY pgrst, 'reload schema';
