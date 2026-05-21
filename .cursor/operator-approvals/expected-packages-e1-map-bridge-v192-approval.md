# Expected Packages E1 Map Bridge V192 Approval

**Default:** not approved. This approval is required before any `product_identifier_map` inserts.

| Field | Value |
|---|---|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Allowed write | INSERT `product_identifier_map` rows only for approved E1 candidates |
| Product creation | forbidden |
| Expected package update | forbidden |
| Production | forbidden |

```text
APPROVED_TO_RUN_STAGING=false
APPROVED_EXPECTED_PACKAGES_E1_MAP_BRIDGE_V192=false
```
