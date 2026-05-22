# Product catalog Wave A2B — AFI link existing product — operator approval

**Scope:** UPDATE `amazon_amazon_fulfilled_inventory.resolved_*` from exact single `products` match on staging. Uses existing `product_identifier_map` for `resolved_catalog_product_id` when present. **No** new `products` or map INSERT (V190B bridge already covers map gaps).

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Prerequisite | V190A2 plan `20260524T220000Z`; tier24 execute `20260524T230000Z` |
| `APPROVED_TO_RUN_STAGING` | `true` |
| `APPROVED_LINK_EXISTING_PRODUCT_ONLY` | `true` |

## Authorized writes

- **UPDATE** `amazon_amazon_fulfilled_inventory` resolver columns only
- Match priority: FNSKU → SKU+ASIN → ASIN (single product only)

## Exclusions

- No `products` INSERT
- No `return_items` writes
- No production
- No ambiguous/multi-product rows

## Batch limit

Default **500** rows per run (`--limit=500`); use `--all` for full cohort.

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_LINK_EXISTING_PRODUCT_ONLY=true
Approved by: Main/user (PRODUCT-CATALOG-WAVE-A-AFI-LINK-EXISTING-EXECUTE-V190A2B)
UTC date: 2026-05-24
```
