# Sam row bd5bf0d6 product spine — V186 operator approval

**Scope:** Governed product import / spine work for staging — **not** auto-create products.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| return_item_id | `bd5bf0d6-500a-4696-80c6-7c0e65f539b6` |
| ASIN | `B0BSDRJ85M` |
| SKU | `TU-8QKU-LV50` |
| `APPROVED_TO_RUN_STAGING` | `true` |

## Preconditions

- [ ] Review `sam-row-product-spine-investigation.md` and `product-spine-plan-if-needed.md`
- [ ] Product created via governed PIM/import path (not agent auto-create)
- [ ] Map enrichment (V185) only after `products.id` confirmed
- [ ] Re-run FBM dry-run before any return_items resolver execute

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
Approved by: Main/user (BD5BF0D6 spine promotion V187)
UTC date: 2026-05-21
```
