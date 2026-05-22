# Package code in inventory views — V204 operator approval

**Scope:** `CREATE OR REPLACE VIEW` on **staging only** (`eiqfaapyumhixxoeltgu`) to expose `packages.package_code` on the Neda inventory read-model.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Original / current (`kxsvedvpjldygtdbylsy`) | **forbidden in this approval** — separate parity pack after staging proof |
| Future production | **forbidden** |
| Allowed write | `CREATE OR REPLACE VIEW` for `v_scanned_items_counted`, `v_inventory_item_status`, `v_inventory_status` only |
| Data mutation | forbidden |
| `package_items` | forbidden |
| Legacy `returns` | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_TO_APPLY_VIEW_DDL=true
```

## Change summary

- Add `package_code` from `public.packages` into `v_scanned_items_counted` (via `return_items.package_id` join).
- Propagate into `v_inventory_item_status` (scanned path; expected path remains NULL until a package row exists).
- Add `max(package_code)` to `v_inventory_status` for package-level scan/chip filter.

## Preconditions

- [ ] V193 product columns already on staging views (verified 20260522)
- [ ] V189 `deleted_at IS NULL` filter present on `v_scanned_items_counted`
- [ ] Review `.cursor/audit-reports/main-v204-package-code-view-ddl-plan/<run_id>/`
- [ ] Post-apply: extend `fetchInventoryItemStatusForNeda` with `packageCode` filter (app change, separate commit)

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_TO_APPLY_VIEW_DDL=true
Approved by: Main/user (MAIN V205 package_code inventory views apply)
UTC date: 2026-05-22
```
