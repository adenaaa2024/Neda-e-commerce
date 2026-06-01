# Product Sheet Staging Apply Wave1 Sample Approval

**Default:** not approved until operator flags are set.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Org | `00000000-0000-0000-0000-000000000001` |
| Store | `509ee1f6-622c-46a5-8110-7b889ba46c2c` |
| Phase F resolve plan | `.cursor/audit-reports/product-sheet-phase-f-resolve-readonly/20260607T160000Z/` |
| Allowed writes | null-fill `products` · insert `product_identifier_map` · upsert `catalog_products` |
| Product creation | forbidden |
| Production / original | forbidden |

## Scope (sample wave only)

| Operation | Max rows | Source |
|-----------|---------:|--------|
| `products` null-fill ASIN/FNSKU | 25 | `sample-wave-null-fill.csv` |
| `product_identifier_map` insert | 25 | `sample-wave-map-inserts.csv` |
| `catalog_products` upsert | 25 | `sample-wave-catalog-upserts.csv` |
| Packaging / spec normalization | 0 | none conflict-free in sample |
| `products` INSERT | **0** | forbidden |

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_SHEET_PHASE_F_SAMPLE_WAVE=true
APPROVED_NULL_FILL_ONLY=true
APPROVED_MAP_INSERT_MAX_25=true
APPROVED_CATALOG_UPSERT_MAX_25=true
APPROVED_PRODUCT_INSERT=false
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_SHEET_PHASE_F_SAMPLE_WAVE=true
APPROVED_NULL_FILL_ONLY=true
APPROVED_MAP_INSERT_MAX_25=true
APPROVED_CATALOG_UPSERT_MAX_25=true
APPROVED_PRODUCT_INSERT=false
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu

## Sign-off

```
Approved by: Main/user (PRODUCT-SHEET-STAGING-APPLY-WAVE1-SAMPLE)
UTC date: 2026-05-21
Notes: Tiny reversible staging sample from Phase F resolve plan 20260607T160000Z only. No product creates, no title overwrite, no original/production.
```
