# Inventory views — return_items deleted_at filter — V189 original approval

**Scope:** Apply `20260825120000_inventory_views_return_items_deleted_at_filter_v189.sql` on **original / Vercel Production DB only**.

| Field | Value |
|-------|--------|
| Original ref | `kxsvedvpjldygtdbylsy` |
| Migration | `supabase/migrations/20260825120000_inventory_views_return_items_deleted_at_filter_v189.sql` |
| `APPROVED_TO_RUN_ORIGINAL` | `true` |
| Connection | `ORIGINAL_DIRECT_POSTGRES_URL` only |

## Change summary

- `v_scanned_items_counted`: add `WHERE r.deleted_at IS NULL` on `return_items`
- `v_inventory_item_status` / `v_inventory_status`: unchanged DDL (consume updated scanned view)

## Preconditions

- [ ] V180 Neda inventory views already applied on original
- [ ] Staging V189 apply reviewed: `inventory-views-return-items-deleted-at-filter-v189/20260523T120000Z/`
- [ ] **Not** staging (`eiqfaapyumhixxoeltgu`) — `STAGING_DIRECT_POSTGRES_URL` must not be the apply target
- [ ] Future separate production project (`NOT_CREATED_YET`) — not this approval

## Explicit exclusions

- No `return_items` DML
- No staging FBM resolver re-execute
- No `package_items`
- No legacy `returns` table

## Sign-off

```
APPROVED_TO_RUN_ORIGINAL=true
ORIGINAL_PROJECT_REF=kxsvedvpjldygtdbylsy
Approved by: Main/user (INVENTORY-VIEWS-V189-ORIGINAL-PREFLIGHT-AND-APPLY)
UTC date: 2026-05-24
```
