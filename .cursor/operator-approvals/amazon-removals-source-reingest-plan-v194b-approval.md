# Amazon removals source re-ingest plan — V194B operator approval (plan only)

**Scope:** Governed `claim_candidates.source_row_id` repoint for stale `amazon_removals` pointers using **order_id+sku tier first** (SKU-only matches excluded from auto-repoint).

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| `APPROVED_TO_RUN_STAGING` | `true` |
| `APPROVED_AT` | `2026-05-26T00:00:00Z` |
| V193B investigation run | `20260525T210000Z` |
| Expected broken cohort | ~1,543 `claim_candidates` |
| Auto-repoint tier | `order_id_sku` deterministic only |
| Manual review | ambiguous `order_id+sku` clusters + all SKU-only tiers |

## Forbidden (this approval)

- Production writes
- SKU-only blind repoint
- Claim submit / delete
- Amazon API live calls (re-ingest is optional / separate approval)

## Plan script (dry-run)

`npx tsx scripts/amazon-removals-source-reingest-plan-v194b-staging.ts --run-id=<id>`

## Execute (separate approval — not included)

Requires follow-on `AMAZON-REMOVALS-SOURCE-REINGEST-EXECUTE-V194B` after manual review queue triage.
