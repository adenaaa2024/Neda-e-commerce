# Inventory Views — Bulk Orphan RI Exclusion (Staging)

**Default:** not approved until operator sets flags below.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Branch | `feature/phase1-latest-stash-land` |
| Audit | `inventory-and-scanner-views-orphan-ri-exclusion-readonly/` |
| Objects | `v_scanned_items_counted`, `v_inventory_item_status`, `v_inventory_status` |

## Allowed

- `CREATE OR REPLACE VIEW` on staging only
- Physical scan gate: `return_items.deleted_at IS NULL` AND `return_items.package_id IS NOT NULL`
- `NOTIFY pgrst, 'reload schema'`

## Forbidden

- Original / production (`kxsvedvpjldygtdbylsy`)
- `expected_packages` mutation
- `return_items` create/delete/update
- `products` / `product_identifier_map` mutation
- Deploy

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_INVENTORY_VIEWS_BULK_ORPHAN_RI_EXCLUSION_STAGING=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_INVENTORY_VIEWS_BULK_ORPHAN_RI_EXCLUSION_STAGING=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
Approved by: Main/user
UTC date: 2026-05-30
Execute prompt: INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION
```
