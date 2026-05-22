# Package code inventory views — V204 original/current parity approval

**Default:** not approved until staging proof (MAIN V205) is signed off.

| Field | Value |
|-------|--------|
| Original/current ref | `kxsvedvpjldygtdbylsy` |
| Staging ref (forbidden target) | `eiqfaapyumhixxoeltgu` |
| DDL source | `.cursor/audit-reports/main-v204-package-code-view-ddl-plan/20260522T160000Z/ddl-plan.sql` |
| Staging proof | `.cursor/audit-reports/main-v205-package-code-v-inventory-item-status-apply/20260522T173000Z/` |
| Allowed write | `CREATE OR REPLACE VIEW` for `v_scanned_items_counted`, `v_inventory_item_status`, `v_inventory_status` only |
| `package_items` / legacy `returns` | forbidden |

```text
APPROVED_TO_RUN_ORIGINAL=true
APPROVED_TO_APPLY_VIEW_DDL_ORIGINAL=true
```

## Sign-off

```
APPROVED_TO_RUN_ORIGINAL=true
APPROVED_TO_APPLY_VIEW_DDL_ORIGINAL=true
Approved by: Main/user (MAIN V206 original parity after V205 staging proof)
UTC date: 2026-05-22
Staging proof run_id: 20260522T173000Z
```
