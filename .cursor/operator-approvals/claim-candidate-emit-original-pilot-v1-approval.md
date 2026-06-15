# Claim candidate emit — original pilot V1 approval

**Phase:** PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-V1 (execute)  
**Contract:** `lib/claims/contracts/claim-candidate-emit-approval-contract-v1.ts`  
**Prerequisites (staging evidence):**
- `SAFE_STAGING_PILOT_ROWS_TRUSTED=yes` — wave1 `6870dbd1`
- `SAFE_EFFECTIVE_DATE_GATE_READY=yes`
- `SAFE_STAGING_EMIT_WAVE2=yes` — wave2 `1e29a52c` (rollback-drilled)
- `SAFE_ROLLBACK_DRILL_PASSED=yes`
- `SAFE_TO_RUN_ORIGINAL_EMIT_PILOT=yes` — plan `20260614T200000Z`

APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_PILOT_V1=yes
MAX_ROWS_CAP=50

## Scope

Original/live pilot write of **claim_ready** preview rows into `claim_candidates` for:

- `removal_shipment_missing` → `shipment_not_received` (`delayed_not_received`) — up to 30
- `removal_order_discrepancy` → `shipment_quantity_mismatch` / `removal_missing_units` — up to 20

**Cap:** 50 total rows (30 + 20 distribution)  
**Environment:** original `kxsvedvpjldygtdbylsy` only

## Explicitly out of scope

- `physical_return_scanner_issue`, `partial_incorrect_reimbursement`
- `needs_review` / `unavailable` previews
- disputed expected-package rows, unresolved product links
- legacy_seed revival, claim_cases, submissions, PDFs
- scanner / Product Core resolver / RBAC / AI changes

## Rollback

Quarantine/supersede by `intake_run_id` + `metadata.emit_origin = preview_emit_v1` — **no hard deletes**.

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | Maysam |
| Date (UTC) | 2026-06-14 |
| Original org | `00000000-0000-0000-0000-000000000001` |
| Original store | `509ee1f6-622c-46a5-8110-7b889ba46c2c` |
| Max rows cap | 50 (30 shipment_missing + 20 order_discrepancy) |

**Signature:** Maysam — APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_PILOT_V1=yes

**Decision:** [x] APPROVED  [ ] DEFER
