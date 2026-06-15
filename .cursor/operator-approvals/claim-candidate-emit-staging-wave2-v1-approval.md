# Claim candidate emit — staging wave 2 V1 approval

**Phase:** PHASE-CLAIM-CANDIDATE-EMIT-STAGING-WAVE2-V1  
**Contract:** `lib/claims/contracts/claim-candidate-emit-approval-contract-v1.ts`  
**Prerequisites:**
- `PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-POST-VERIFY-V1` — `SAFE_STAGING_PILOT_ROWS_TRUSTED=yes`
- `PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1` — `SAFE_EFFECTIVE_DATE_GATE_READY=yes`

APPROVED_CLAIM_CANDIDATE_EMIT_STAGING_WAVE2_V1=yes

## Scope

Staging-only second pilot batch (**max 50** inserted/updated rows) for **claim_ready** previews:

1. **Prefer** `removal_shipment_missing` not already emitted (active trusted dedupe)
2. **Fill** with `removal_order_discrepancy` only when no active dedupe match exists
3. Respect effective-date gates, dedupe, and identity conflict rules

**Environment:** staging `eiqfaapyumhixxoeltgu` only

## Explicitly out of scope

- `physical_return_scanner_issue`, `partial_incorrect_reimbursement`
- `needs_review` / `unavailable` previews
- disputed expected-package rows, unresolved product links
- legacy_seed / quarantined / rejected rows
- claim_cases / submissions / PDFs
- scanner / Product Core resolver / RBAC / AI changes
- original DB

## Rollback

Quarantine/supersede by `intake_run_id` + `metadata.emit_origin = preview_emit_v1` — **no hard deletes**.

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | Maysam |
| Date (UTC) | 2026-06-14 |
| Staging org | `00000000-0000-0000-0000-000000000001` |
| Staging store | `509ee1f6-622c-46a5-8110-7b889ba46c2c` |
| Max rows cap | 50 |

**Signature:** Maysam (staging wave 2 V1)

**Decision:** [x] APPROVED  [ ] DEFER
