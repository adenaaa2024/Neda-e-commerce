# Inventory Views Product ID Columns V193 Original Parity Approval

**Default:** not approved. This approval is required before applying `CREATE OR REPLACE VIEW` to original/current DB.

| Field | Value |
|---|---|
| Original/current ref | `kxsvedvpjldygtdbylsy` |
| Allowed write | `CREATE OR REPLACE VIEW` for inventory read models only |
| Future production | forbidden |
| Product creation | forbidden |
| `package_items` | forbidden |
| Destructive DDL | forbidden |

```text
APPROVED_TO_RUN_ORIGINAL=true
APPROVED_TO_APPLY_VIEW_DDL_ORIGINAL=true
```
