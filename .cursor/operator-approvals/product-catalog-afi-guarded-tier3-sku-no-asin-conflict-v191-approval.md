# Product catalog AFI guarded Tier 3 SKU/no-ASIN-conflict V191 approval

**Default:** not approved. Preflight only until Main/user flips the flag.

| Field | Value |
|---|---|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Allowed write | UPDATE `amazon_amazon_fulfilled_inventory` resolver columns only |
| Product creation | forbidden |
| Map inserts | forbidden |
| Production | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_GUARDED_TIER3_SKU_NO_ASIN_CONFLICT=true
```
