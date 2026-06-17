# Claim case creation pilot V1 approval

**Phase:** PHASE-CLAIM-CASE-CREATION-PILOT-V1 (execute)  
**Contract:** `lib/claims/contracts/claim-case-creation-contract-v1.ts`  
**Prerequisites:**
- `SAFE_CASE_CREATION_PREVIEW_READY=yes` — preview `20260615T170000Z`
- `SAFE_TO_BUILD_CASE_CREATION_PILOT=yes` — preview UI `20260615T180000Z`
- Pilot intake_run_id `a8a892fe-37d5-4d74-9ea2-02af8fd095ce` restored and trusted

APPROVED_CLAIM_CASE_CREATION_PILOT_V1=yes
MAX_CASES_CAP=10
SHIPMENT_MISSING_CAP=6
ORDER_DISCREPANCY_CAP=4

## Scope

Original/live controlled INSERT into `claim_cases` + `claim_lines` + `claim_case_events` for:

- `removal_shipment_missing` — up to **6** cases
- `removal_order_discrepancy` — up to **4** cases

**Total cap:** 10 cases (first pilot wave)  
**Environment:** original `kxsvedvpjldygtdbylsy` only  
**Intake run:** `a8a892fe-37d5-4d74-9ea2-02af8fd095ce` only

## Explicitly out of scope

- `claim_submissions`, Amazon submit, PDF generation
- `physical_return_scanner_issue`, `partial_incorrect_reimbursement`
- scanner / Product Core resolver / RBAC / AI changes
- All 50 cases in one wave (requires separate approval)

## Rollback

Soft-close cases scoped by `metadata.case_creation_origin = case_creation_pilot_v1` + `metadata.pilot_case_run_id` — **no hard deletes**.

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | Maysam |
| Date (UTC) | 2026-06-15 |
| Original org | `00000000-0000-0000-0000-000000000001` |
| Original store | `509ee1f6-622c-46a5-8110-7b889ba46c2c` |
| Max cases cap | 10 (6 shipment + 4 order) |

**Signature:** Maysam — APPROVED_CLAIM_CASE_CREATION_PILOT_V1=yes

**Decision:** [x] APPROVED  [ ] DEFER
