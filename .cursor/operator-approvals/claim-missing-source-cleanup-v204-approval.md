# Claim missing-source cleanup — V204 operator approval

**Scope:** Quarantine `claim_candidates` with `source_table = amazon_removals` and no matching `amazon_removals` row (V202 blocker B2).

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| `APPROVED_TO_RUN_STAGING` | `true` |
| `APPROVED_AT` | `2026-05-22` |
| V202 census run | `20260522T180000Z` |
| V203 orphan FK | `PASS` (`20260522T190000Z`) |
| Expected rows | **1,543** |
| Cleanup method | `quarantine` — `candidate_status` → `quarantined_missing_source` (no DELETE) |

## Forbidden

- Production writes
- DELETE on claim tables
- Claim submit / Amazon API

## Execute script

`npx tsx scripts/claim-missing-source-cleanup-v204-staging.ts --run-id=<id> --execute`
