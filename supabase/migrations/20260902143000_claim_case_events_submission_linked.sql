-- Add submission_linked to claim_case_events (additive).
BEGIN;

ALTER TABLE public.claim_case_events
  DROP CONSTRAINT IF EXISTS claim_case_events_type_chk;

ALTER TABLE public.claim_case_events
  ADD CONSTRAINT claim_case_events_type_chk CHECK (event_type IN (
    'case_opened',
    'status_changed',
    'assigned',
    'evidence_added',
    'sla_breached',
    'escalated',
    'trid_linked',
    'case_closed',
    'submission_linked'
  ));

COMMIT;
