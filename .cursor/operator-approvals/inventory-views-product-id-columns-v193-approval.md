# Inventory Views Product ID Columns V193 Approval

**Default:** not approved. This approval is required before applying `CREATE OR REPLACE VIEW` on staging.

| Field | Value |
|---|---|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Allowed write | `CREATE OR REPLACE VIEW` for inventory read models only |
| Production/original | forbidden |
| Product creation | forbidden |
| `package_items` | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_TO_APPLY_VIEW_DDL=true
```
