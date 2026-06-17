# Claim submission record pilot V1 approval

**Phase:** PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1 (controlled INSERT)  
**Contract:** `lib/claims/submission/claim-submission-record-pilot-v1.ts`  
**Migration:** `supabase/migrations/20260918120000_phase_claim_submission_record_pilot_v1_anchor.sql`

## Prerequisites (must be yes before execute)

- `SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY=yes`
- `SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT=yes`
- `SAFE_TRID_REFERENCE_GRAPH_VERIFIED=yes` (recommended — operator may waive with documented risk)
- Trusted 10 open pilot cases (6 shipment + 4 order); closed duplicates excluded

APPROVED_CLAIM_SUBMISSION_RECORD_PILOT_V1=yes
APPROVED_CLAIM_SUBMISSIONS_SCHEMA_MIGRATION_V1=yes

## Scope

Original/live `kxsvedvpjldygtdbylsy` only:

- INSERT up to **10** `claim_submissions` rows (one per active pilot `claim_case_id`)
- `submission_mode = manual_filing` in `source_payload`
- `status = draft` or `ready_to_send` (no Amazon submission)
- `submission_id` NULL (no external Amazon case id at create)
- Legacy **3** return-linked submissions **untouched**

**Pilot run:** `pilot-20260615T190000Z`  
**Intake run:** `a8a892fe-37d5-4d74-9ea2-02af8fd095ce`

## Explicitly out of scope

- Amazon SP-API / browser automation / auto-upload
- Mutating `claim_cases`, `claim_lines`, `claim_candidates`
- Hard-delete rollback (soft-cancel via `rejected` + payload flags only)
- scanner / Product Core resolver / RBAC changes
- AI/GPT

## Rollback

Scoped soft-cancel SQL generated per run (`submission_record_origin` + `submission_record_run_id`).

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | Maysam |
| Date (UTC) | 2026-06-17 |
| Original org | `00000000-0000-0000-0000-000000000001` |
| Original store | `509ee1f6-622c-46a5-8110-7b889ba46c2c` |
| Max inserts | 10 open pilot only |

**Signature:** approved — tokens set for PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1

**Decision:** [x] APPROVED  [ ] DEFER
