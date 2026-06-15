# Claim candidate emit — original rollback drill V1 approval

**Phase:** PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-ROLLBACK-DRILL-V1  
**Target:** Original `kxsvedvpjldygtdbylsy` only

APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_ROLLBACK_DRILL_V1=yes

## Scope

Quarantine/supersede rollback drill for **original pilot only**:

- `intake_run_id`: `a8a892fe-37d5-4d74-9ea2-02af8fd095ce`
- 50 rows (30 `removal_shipment_missing` + 20 `removal_order_discrepancy`)
- `metadata.emit_origin = preview_emit_v1`

**Unrelated claim_candidates must remain unchanged** (legacy quarantine + other intake runs).

## Policy

- **No hard DELETE**
- Quarantine + `candidate_status = superseded` only
- No claim_cases, submissions, PDFs, scanner, Product Core, RBAC, or staging changes
- No automatic restore (restore plan output only)

## Prerequisites

- `SAFE_ORIGINAL_EMIT_PILOT=yes`
- `SAFE_ORIGINAL_PILOT_ROWS_TRUSTED=yes`

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | Maysam |
| Date (UTC) | 2026-06-15 |
| Original org | `00000000-0000-0000-0000-000000000001` |
| Rollback target | `a8a892fe-37d5-4d74-9ea2-02af8fd095ce` |

**Signature:** Maysam (original rollback drill V1)

**Decision:** [x] APPROVED  [ ] DEFER
