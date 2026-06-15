# Claim candidate emit — staging rollback drill V1 approval

**Phase:** PHASE-CLAIM-CANDIDATE-EMIT-STAGING-ROLLBACK-DRILL-V1  
**Target:** Staging `eiqfaapyumhixxoeltgu` only

APPROVED_CLAIM_CANDIDATE_EMIT_STAGING_ROLLBACK_DRILL_V1=yes

## Scope

Quarantine/supersede rollback drill for **Wave 2 only**:

- `intake_run_id`: `1e29a52c-b50e-41aa-8b7f-03448e727f3f`
- 50 × `removal_shipment_missing`
- `metadata.emit_origin = preview_emit_v1`

**Wave 1 must remain active:** `6870dbd1-dac0-4f33-b06c-bfe16d7f3bf5`

## Policy

- **No hard DELETE**
- Quarantine + `candidate_status = superseded` only
- No claim_cases, submissions, PDFs, scanner, Product Core, RBAC, or source-data changes
- No automatic restore (restore plan output only if needed)

## Operator sign-off

| Field | Value |
|-------|-------|
| Approved by | Maysam |
| Date (UTC) | 2026-06-14 |
| Staging org | `00000000-0000-0000-0000-000000000001` |
| Rollback target | `1e29a52c-b50e-41aa-8b7f-03448e727f3f` |

**Signature:** Maysam (staging rollback drill V1)

**Decision:** [x] APPROVED  [ ] DEFER
