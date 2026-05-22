# Claim candidates orphan FK remediation — V203 operator approval

**Scope:** NULL or FK-guarded remap of `claim_candidates.resolved_product_id` where ∉ `products.id` (V202 blocker B1).

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| `APPROVED_TO_RUN_STAGING` | `true` |
| `APPROVED_AT` | `2026-05-22` |
| V202 census run | `20260522T180000Z` |
| Expected orphan rows | **4,736** |
| Remap-from-source (dry-run expectation) | **0** (source RPIDs also orphan or absent) |
| Primary action | `SET resolved_product_id = NULL` with preimage + rollback SQL |

## Forbidden

- Production writes
- Claim submit / delete claim tables
- Amazon API
- Product auto-create

## Execute script

`npx tsx scripts/claim-orphan-fk-remediation-v203-staging.ts --run-id=<id> --execute`
