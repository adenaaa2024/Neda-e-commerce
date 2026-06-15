# Claim candidate emit — staging pilot V1 approval

**Phase:** PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-V1  
**Contract:** `lib/claims/contracts/claim-candidate-emit-approval-contract-v1.ts`  
**Prerequisite evidence:** `phase-claim-first-safe-families-preview-generators-v1/20260614T090000Z/`

APPROVED_CLAIM_CANDIDATE_EMIT_STAGING_PILOT_V1=yes

## Scope

Staging-only pilot write of **claim_ready** preview rows into `claim_candidates` for:

- `removal_shipment_missing` → `shipment_not_received` (`delayed_not_received`)
- `removal_order_discrepancy` → `shipment_quantity_mismatch` / `removal_missing_units` (when claim_ready in window)

**Max rows:** 50 per pilot run  
**Environment:** staging `eiqfaapyumhixxoeltgu` only

## Explicitly out of scope

- `physical_return_scanner_issue` (preview-only Wave-1)
- `partial_incorrect_reimbursement` (preview-only Wave-1)
- `customer_return_not_reimbursed`
- `missing_reimbursement` (linkage < 25%)
- claim_cases / claim_lines creation
- claim submission / PDF generation
- legacy_seed revival
- scanner / Product Core resolver / RBAC changes

## Rollback

Rows tagged `intake_run_id` + `metadata.emit_origin = preview_emit_v1`. Rollback via quarantine or supersede — **no hard deletes**.

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | Maysam |
| Date (UTC) | 2026-06-14 |
| Staging org | `00000000-0000-0000-0000-000000000001` |
| Staging store | `509ee1f6-622c-46a5-8110-7b889ba46c2c` |
| Max rows cap | 50 |

**Signature:** Maysam (staging pilot V1)

**Decision:** [x] APPROVED  [ ] DEFER
