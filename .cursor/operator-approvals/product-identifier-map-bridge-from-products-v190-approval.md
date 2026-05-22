# Product identifier map bridge from products — V190B operator approval

**Scope:** INSERT `product_identifier_map` bridge rows on **staging only** from existing `products` rows that lack any map row. Exact identifiers only.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Wave | B1 (catalog completeness) |
| Prerequisite audit | `product-catalog-import-completeness-wave-190/20260524T180000Z` |
| `APPROVED_TO_RUN_STAGING` | `true` |
| `APPROVED_TO_INSERT_MAP_ROWS` | `true` |

## Authorized writes (when approved)

- **INSERT** into `public.product_identifier_map` only
- One primary bridge row per eligible `products.id`
- Identifiers copied **exactly** from `products.sku`, `products.asin`, `products.fnsku` (trimmed)
- `match_source` = `product_bridge_v190b`
- `external_listing_id` = `product_bridge_v190b:<product_id>`
- `source_report_type` = `product_bridge_v190b`

## Preconditions

- [ ] Review dry-run: `.cursor/audit-reports/product-identifier-map-bridge-from-products-v190/<run_id>/`
- [ ] `insert_candidates` count matches operator expectation
- [ ] Zero rows in `blocked_*` classes unless explicitly waived per PK list
- [ ] **No** `products` INSERT/UPDATE
- [ ] **No** `return_items` resolver execute in same window
- [ ] **No** production — `STAGING_DIRECT_POSTGRES_URL` only

## Explicit exclusions

- No new `products` rows (no auto-create from title/OCR/fuzzy/AI)
- No UPC-only bridge in Wave B1 (SKU/ASIN/FNSKU required on product row)
- No `package_items`
- No Amazon live API
- No overwrite of existing map row linked to a **different** `product_id`

## Batch limits (execute prompt)

| Limit | Default |
|-------|---------|
| Max inserts per run | 500 (operator may raise in execute approval) |
| Idempotent re-run | Skip products that already have any map row |

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_TO_INSERT_MAP_ROWS=true
Approved by: Main/user (PRODUCT-CATALOG-WAVE-B1-MAP-BRIDGE-EXECUTE-V190B)
UTC date: 2026-05-24
Notes: Batch limit 500; staging eiqfaapyumhixxoeltgu only.
```
