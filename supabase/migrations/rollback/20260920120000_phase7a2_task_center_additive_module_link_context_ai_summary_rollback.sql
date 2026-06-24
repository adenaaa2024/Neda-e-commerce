-- =============================================================================
-- ROLLBACK — PHASE-7A2 Task Center additive reconcile
--
-- Reverses 20260920120000_phase7a2_task_center_additive_module_link_context_ai_summary.sql
-- Drops ONLY the additive objects. Does NOT touch existing Phase 7A columns.
-- Staging only.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS public.task_items_organization_module_link_type_idx;

ALTER TABLE public.task_items
  DROP CONSTRAINT IF EXISTS task_items_module_link_type_check;

ALTER TABLE public.task_items
  DROP COLUMN IF EXISTS ai_summary;

ALTER TABLE public.task_items
  DROP COLUMN IF EXISTS module_context;

ALTER TABLE public.task_items
  DROP COLUMN IF EXISTS module_link_type;

COMMIT;

NOTIFY pgrst, 'reload schema';
