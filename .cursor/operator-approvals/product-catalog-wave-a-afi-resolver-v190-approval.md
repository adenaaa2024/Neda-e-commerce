# Product catalog Wave A — AFI tier-1 resolver — V190A operator approval

**Scope:** Wave-2 **tier-1 (exact FNSKU)** resolver backfill on `amazon_amazon_fulfilled_inventory` on **staging only**.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Source table | `amazon_amazon_fulfilled_inventory` |
| Tier | 1 (FNSKU exact → `product_identifier_map`) |
| Prerequisite | `product-identifier-map-bridge-from-products-v190/20260524T200000Z` (B1 map bridge complete) |
| `APPROVED_TO_RUN_STAGING` | `true` |

## Authorized writes

- **UPDATE** `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence` on `amazon_amazon_fulfilled_inventory` only
- Audit rows in run-scoped `product_id_mapping_v176_audit_*` table

## Explicit exclusions

- No new `products` rows
- No `product_identifier_map` INSERT (B1 already done)
- No `return_items` resolver execute
- No tier 4 / other tables in this approval
- No production
- No `package_items`
- No title/OCR/fuzzy/AI

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
Approved by: Main/user (PRODUCT-CATALOG-WAVE-A-AFI-RESOLVER-EXECUTE-V190A)
UTC date: 2026-05-24
```