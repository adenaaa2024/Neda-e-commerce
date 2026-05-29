# Removal 9-month backfill fetch (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Production / original | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_9_MONTH_BACKFILL_FETCH=true
```

## Scope

- SP-API fetch only: `GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA` + `GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA`
- Chunked monthly windows; synthetic `raw_report_uploads` only per chunk (`runPipeline: false`)
- Domain sync / rebuild under separate approval per chunk batch
- No `products.insert` / no `product_identifier_map.insert`

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_9_MONTH_BACKFILL_FETCH=true
Approved by: Maysam Ebrahimi
UTC date: 05272026
Max chunks per execute session (default 2):
```
