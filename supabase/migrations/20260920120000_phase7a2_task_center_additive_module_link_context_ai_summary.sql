-- =============================================================================
-- PHASE-7A2 — Task Center additive reconcile (Option A; staging apply; RLS-gated)
--
-- Purpose:
--   Add ONLY the missing UI/queue-facing fields required by the new Task Center
--   contract, on top of the existing Phase 7A schema. Strictly additive.
--
-- Adds to public.task_items:
--   * module_link_type text NULL  (+ CHECK, nullable)
--   * module_context   jsonb NOT NULL DEFAULT '{}'::jsonb
--   * ai_summary       jsonb NOT NULL DEFAULT '{}'::jsonb
--   * index task_items_organization_module_link_type_idx (organization_id, module_link_type)
--
-- Guarantees:
--   * Does NOT rename/drop source_module / source_entity_type / source_entity_id
--     / source_snapshot / metadata — low-level polymorphic identity preserved.
--   * No new tables; no teams/departments tables; no duplicate task tables.
--   * RLS inherited from existing table policies (column-level grants follow table).
--   * No client write policies added (Phase 7A remains read-only for authenticated).
--   * Conservative, no-invent backfill: maps source_entity_type -> module_link_type
--     ONLY on exact value match for the three claim link types.
-- =============================================================================

BEGIN;

-- ── 1) Additive columns ───────────────────────────────────────────────────────

ALTER TABLE public.task_items
  ADD COLUMN IF NOT EXISTS module_link_type text NULL;

ALTER TABLE public.task_items
  ADD COLUMN IF NOT EXISTS module_context jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.task_items
  ADD COLUMN IF NOT EXISTS ai_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── 2) CHECK constraint (nullable; additive) ──────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.task_items'::regclass
      AND conname = 'task_items_module_link_type_check'
  ) THEN
    ALTER TABLE public.task_items
      ADD CONSTRAINT task_items_module_link_type_check
      CHECK (
        module_link_type IS NULL
        OR module_link_type IN (
          'claim_candidate',
          'claim_case',
          'claim_review_work_item',
          'scanner_review',
          'import_error',
          'automation_run',
          'manual_task'
        )
      );
  END IF;
END $$;

-- ── 3) Column documentation ───────────────────────────────────────────────────

COMMENT ON COLUMN public.task_items.module_link_type IS
  'UI/queue-facing link discriminator. Nullable. One of: claim_candidate, claim_case, '
  'claim_review_work_item, scanner_review, import_error, automation_run, manual_task. '
  'source_module/source_entity_type remain the low-level polymorphic identity.';

COMMENT ON COLUMN public.task_items.module_context IS
  'UI link-chip payload (assistive context, not source of truth). Expected keys: '
  'deep_link, entity_label, source_module, summary.';

COMMENT ON COLUMN public.task_items.ai_summary IS
  'Assistive AI summary only — never authoritative. Expected keys: summary, confidence '
  '(low|medium|high), generated_at, generated_by, source_fields[].';

-- ── 4) Index for queue filtering ──────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS task_items_organization_module_link_type_idx
  ON public.task_items (organization_id, module_link_type);

-- ── 5) Conservative, no-invent backfill ───────────────────────────────────────
-- Only set module_link_type where source is claims AND source_entity_type already
-- equals one of the three canonical claim link types. No fabrication of data.

UPDATE public.task_items
SET module_link_type = source_entity_type
WHERE module_link_type IS NULL
  AND deleted_at IS NULL
  AND source_module = 'claims'
  AND source_entity_type IN (
    'claim_candidate',
    'claim_case',
    'claim_review_work_item'
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
