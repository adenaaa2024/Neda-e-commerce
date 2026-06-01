# Product Sheet Phase 1 Closeout Safe Waves Approval

**Default:** not approved until operator flags are set.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Org | `00000000-0000-0000-0000-000000000001` |
| Store | `509ee1f6-622c-46a5-8110-7b889ba46c2c` |
| Phase F resolve plan | `.cursor/audit-reports/product-sheet-phase-f-resolve-readonly/20260607T160000Z/` |
| PIM dryrun | `.cursor/audit-reports/product-sheet-import-pim-normalization-dryrun/20260530T065129Z/` |
| Allowed writes | null-fill `products` · insert `product_identifier_map` · upsert `catalog_products` |
| Product creation | forbidden |
| Production / original | forbidden |

## Scope (Phase 1 closeout)

| Operation | Max rows per wave | Source |
|-----------|------------------:|--------|
| `products` null-fill ASIN/FNSKU | 100 | tier2 conflict-free from Phase F filters |
| `product_identifier_map` insert / FNSKU null-fill | 100 | exact conflict-free map plan |
| `catalog_products` upsert | 100 | tier2 conflict-free catalog plan |
| Packaging / spec | 0 | remaining spec rows blocked (needs_review) |
| `products` INSERT | **0** | forbidden |

## Blocked (never in this prompt)

- 21 identifier mismatch class A rows
- 35 duplicate ASIN class C groups
- 1,700 product-create candidates without governed seed approval
- `product_name` / vendor bulk overwrite
- Fuzzy merge

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_SHEET_PHASE1_CLOSEOUT=true
APPROVED_NULL_FILL_MAX_100=true
APPROVED_MAP_INSERT_MAX_100=true
APPROVED_CATALOG_UPSERT_MAX_100=true
APPROVED_PRODUCT_INSERT=false
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_SHEET_PHASE1_CLOSEOUT=true
APPROVED_NULL_FILL_MAX_100=true
APPROVED_MAP_INSERT_MAX_100=true
APPROVED_CATALOG_UPSERT_MAX_100=true
APPROVED_PRODUCT_INSERT=false
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu

## Sign-off

```
Approved by: Main/user (PRODUCT-SHEET-PHASE1-CLOSEOUT-SAFE-WAVES)
UTC date: 2026-05-27
Notes: Phase 1 closeout on staging only. Tier2 conflict-free rows from Phase F 20260607T160000Z. Max 100 rows per type per wave. Rollback/preimage required. No product creates.
```
