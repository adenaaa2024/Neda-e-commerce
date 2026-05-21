# Product catalog Wave A2 — AFI seed / link batches — V190A2 operator approval

**Scope:** Governed staging batches after V190A tier-1 resolver. **Plan-only** until sub-approvals execute.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Table | `amazon_amazon_fulfilled_inventory` |
| Prerequisite | V190A execute `20260524T210100Z`; B1 bridge `20260524T200000Z` |
| `APPROVED_TO_RUN_STAGING` | `true` |
| `APPROVED_PRODUCT_CREATE_FROM_AFI` | `false` |
| `APPROVED_RESOLVER_TIER_2_4_ONLY` | `true` |
| `APPROVED_LINK_EXISTING_PRODUCT_ONLY` | `false` |

## Batch definitions (execute requires matching flag)

| Batch | Action | Creates `products`? |
|-------|--------|---------------------|
| **A** | Wave-2 tier 2 + tier 4 resolver on unresolved AFI | No |
| **B** | Link AFI → existing `products.id` (exact FNSKU/SKU+ASIN/ASIN) + map if missing | No |
| **C** | Governed product+map CREATE from AFI (NEXT-PRODUCT-32 pattern) | **Yes** — separate explicit approval |

## Forbidden (all batches)

- Title/OCR/fuzzy/AI matching
- Production
- `return_items` writes
- `package_items`

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_CREATE_FROM_AFI=false
APPROVED_RESOLVER_TIER_2_4_ONLY=true
APPROVED_LINK_EXISTING_PRODUCT_ONLY=false
Approved by: Main/user (PRODUCT-CATALOG-WAVE-A-AFI-RESOLVER-TIER24-EXECUTE-V190A2A)
UTC date: 2026-05-24
Notes: Batch A only — tiers 2 and 4 on amazon_amazon_fulfilled_inventory; no product CREATE.
```
