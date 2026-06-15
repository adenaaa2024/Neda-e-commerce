# Claim candidate emit — original pilot restore for review V1 approval

**Phase:** PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-RESTORE-FOR-REVIEW-V1  
**Target:** Original `kxsvedvpjldygtdbylsy` only

APPROVED_RESTORE_ORIGINAL_PILOT_FOR_REVIEW_V1=yes

## Scope

Controlled restore of **original pilot only** after rollback drill:

- `intake_run_id`: `a8a892fe-37d5-4d74-9ea2-02af8fd095ce`
- 50 rows (`metadata.emit_origin = preview_emit_v1`, `metadata.rollback_mode = quarantine_supersede`)
- Un-quarantine + restore `candidate_status = detected` + rebuild `dedupe_key`

**Unrelated claim_candidates must remain unchanged.**

## Policy

- **No hard DELETE**
- No claim_cases, submissions, PDFs, scanner, Product Core, RBAC, or staging changes
- Do not restore legacy_seed, rejected, or rows outside target intake_run_id

## Prerequisites

- `SAFE_ORIGINAL_ROLLBACK_DRILL_PASSED=yes`
- `SAFE_TO_RESTORE_ORIGINAL_PILOT_FOR_REVIEW=yes`

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | Maysam |
| Date (UTC) | 2026-06-15 |
| Original org | `00000000-0000-0000-0000-000000000001` |
| Restore target | `a8a892fe-37d5-4d74-9ea2-02af8fd095ce` |

**Signature:** Maysam (original pilot restore for review V1)

**Decision:** [x] APPROVED  [ ] DEFER
