# SP-API removal shipment fetch

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Production / original | forbidden |
| Product create from title only | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH=true
```

## Scope

- Reports API fetch for:
  - `GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA`
  - `GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA`
- Download → synthetic `raw_report_uploads` (no direct domain write in fetch phase)

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH=true
Approved by: Maysam Ebrahimi
UTC date: 05272026
```
