# Amazon removal shipments orphan source RPID — V206 operator approval

**Scope:** NULL or identifier_map remap of `amazon_removal_shipments.resolved_product_id` where ∉ `products.id`.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| `APPROVED_TO_RUN_STAGING` | `true` |
| `APPROVED_AT` | `2026-05-22` |
| V203–V205 | PASS |
| Expected orphan rows | **4,718** |
| Dry-run plan | **4,714** remap (4,647 FNSKU + 67 SKU map), **4** NULL |

## Forbidden

- Production writes
- DELETE on operational/claim tables
- Amazon API / claim submit

## Execute

`npx tsx scripts/removal-shipments-source-rpid-cleanup-v206-staging.ts --run-id=<id> --execute`
