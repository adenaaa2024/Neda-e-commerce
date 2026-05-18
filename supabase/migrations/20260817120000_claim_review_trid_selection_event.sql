-- =============================================================================
-- NEXT-CLAIM-TRID-05 — Allow append-only operator TRID selection audit events.
-- =============================================================================
-- Created as a migration file only. Do not apply to production unless explicitly
-- approved through the normal Supabase migration workflow.
-- =============================================================================

BEGIN;

ALTER TABLE public.claim_review_work_item_events
  DROP CONSTRAINT IF EXISTS claim_review_work_item_events_type_chk;

ALTER TABLE public.claim_review_work_item_events
  ADD CONSTRAINT claim_review_work_item_events_type_chk CHECK (event_type IN (
    'created',
    'assigned',
    'unassigned',
    'state_changed',
    'priority_changed',
    'sla_reset',
    'follow_up_scheduled',
    'quarantined',
    'escalated',
    'human_override',
    'ai_suggestion_recorded',
    'operator_trid_selection_recorded',
    'completed',
    'cancelled'
  ));

COMMENT ON CONSTRAINT claim_review_work_item_events_type_chk
  ON public.claim_review_work_item_events IS
  'Allowed review work item audit event types; NEXT-CLAIM-TRID-05 adds operator_trid_selection_recorded for append-only financial reference selection.';

COMMIT;

NOTIFY pgrst, 'reload schema';
