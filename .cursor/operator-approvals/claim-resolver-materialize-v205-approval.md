# Claim resolver materialize — V205 operator approval

**Scope:** Governed `resolved_product_id` materialize on `claim_candidates` + `claim_candidate_drafts` after V203/V204 cleanup.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| `APPROVED_TO_RUN_STAGING` | `true` |
| `APPROVED_AT` | `2026-05-22` |
| V203 orphan FK | `PASS` (`20260522T190000Z`) |
| V204 missing-source quarantine | `PASS` (`20260522T200000Z`) |
| Policy | `identifier_map` + `source_resolved` only; FK guard via `products` join; no product auto-create |

## Forbidden

- Production writes
- DELETE on claim tables
- Claim submit / Amazon API / AI

## Execute script

`npx tsx scripts/claim-resolver-materialize-v205-staging.ts --run-id=<id> --execute`
