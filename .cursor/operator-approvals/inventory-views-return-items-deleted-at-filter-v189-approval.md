# Inventory views — return_items deleted_at filter — V189 operator approval

**Scope:** Apply `20260825120000_inventory_views_return_items_deleted_at_filter_v189.sql` on **staging only**.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Migration | `supabase/migrations/20260825120000_inventory_views_return_items_deleted_at_filter_v189.sql` |
| `APPROVED_TO_RUN_STAGING` | `true` |

## Change summary

- `v_scanned_items_counted`: add `WHERE r.deleted_at IS NULL` on `return_items`
- `v_inventory_item_status` / `v_inventory_status`: unchanged DDL (consume updated scanned view)

## Preconditions

- [ ] V180 views already applied on staging
- [ ] Fake/test return_items soft-deleted (Track A / V186 cleanup) — optional but expected
- [ ] Review audit `.cursor/audit-reports/inventory-views-return-items-deleted-at-filter-v189/<run_id>/`
- [ ] **No production** — `STAGING_DIRECT_POSTGRES_URL` only

## Explicit exclusions

- No `package_items`
- No legacy `returns` table
- No `return_items` data writes in this prompt

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
Approved by: Main/user (INVENTORY-VIEWS-DELETED-AT-FILTER-APPLY-V189)
UTC date: 2026-05-22
```
