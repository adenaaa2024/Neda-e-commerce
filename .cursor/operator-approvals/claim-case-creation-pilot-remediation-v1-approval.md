# Claim case creation pilot remediation V1 approval

**Phase:** PHASE-CLAIM-CASE-CREATION-PILOT-REMEDIATION-V1  
**Target:** Original `kxsvedvpjldygtdbylsy` only

APPROVED_CLAIM_CASE_CREATION_PILOT_REMEDIATION_V1=yes

## Scope

Soft-close **10 duplicate** scoped pilot cases (keep canonical **10** active) for:

- `metadata.case_creation_origin` = `case_creation_pilot_v1`
- `metadata.pilot_case_run_id` = `pilot-20260615T190000Z`
- `metadata.intake_run_id` = `a8a892fe-37d5-4d74-9ea2-02af8fd095ce`

**Retain:** `CANONICAL_PILOT_V1_CANDIDATE_IDS` — 6 `removal_shipment_missing` + 4 `removal_order_discrepancy`  
**Remediate:** duplicate second-batch cases only — **no hard deletes**

## Explicitly out of scope

- `claim_candidates`, source tables, new cases/lines (except audit events)
- `claim_submissions`, Amazon submit, PDF generation
- scanner / Product Core resolver / RBAC / AI changes

## Rollback

Scoped by `metadata.remediation_run_id` — reopen remediated cases/lines only.

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | Maysam |
| Date (UTC) | 2026-06-16 |
| Original org | `00000000-0000-0000-0000-000000000001` |
| Original store | `509ee1f6-622c-46a5-8110-7b889ba46c2c` |

**Signature:** Maysam — APPROVED_CLAIM_CASE_CREATION_PILOT_REMEDIATION_V1=yes

**Decision:** [x] APPROVED  [ ] DEFER
