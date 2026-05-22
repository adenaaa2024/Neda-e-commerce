# return_item bd5bf0d6 identifier normalize — V188 operator approval

**Scope:** Scan-parity only on staging — trim ASIN CRLF + align FNSKU to AFI canonical.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| return_item_id | `bd5bf0d6-500a-4696-80c6-7c0e65f539b6` |
| ASIN target | `B0BSDRJ85M` |
| FNSKU target | `X00525Q5XZ` (from AFI `fulfillment_channel_sku`) |
| `APPROVED_TO_RUN_STAGING` | `true` |

## Explicit exclusions

- No `resolved_product_id` / resolver status changes
- No resolver re-execute
- No production

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
Approved by: Main/user (identifier normalize V188)
UTC date: 2026-05-22
```
