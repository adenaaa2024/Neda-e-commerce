# return_item bd5bf0d6 ASIN CRLF normalize — V188 operator approval

**Scope:** Fix `return_items.asin` whitespace only on staging — **separate** from V187 spine promotion.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| return_item_id | `bd5bf0d6-500a-4696-80c6-7c0e65f539b6` |
| Expected ASIN after trim | `B0BSDRJ85M` |
| `APPROVED_TO_RUN_STAGING` | `true` |

## Preconditions

- [ ] V187 spine complete (`products` + `product_identifier_map` + AFI resolved)
- [ ] Preimage CSV of `return_items` row before UPDATE
- [ ] **No** resolver execute in same window

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
Approved by: Main/user (ASIN CRLF normalize V188)
UTC date: 2026-05-22
```
