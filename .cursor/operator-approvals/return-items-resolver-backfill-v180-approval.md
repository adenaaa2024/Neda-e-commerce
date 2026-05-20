# Return items resolver backfill — operator approval (V180 gate)

**Purpose:** Gate optional `products` LEFT JOIN on `v_inventory_item_status.resolved_product_id`.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Production | **Blocked** until separate production approval |
| `APPROVED_TO_RUN_STAGING` | `false` |

## Preconditions (staging)

- [ ] `return_items.resolved_product_id` backfill dry-run reviewed
- [ ] `identifier_resolution_status` populated for backfilled rows
- [ ] Inventory views migration snapshot applied (`20260824120000_inventory_views_neda_snapshot_v180.sql`)
- [ ] `fetchInventoryItemStatusForNeda` smoke still PASS after view extension

## Optional view change (after approval)

Apply the commented block in `supabase/migrations/20260824120000_inventory_views_neda_snapshot_v180.sql` as a **new** migration (CREATE OR REPLACE VIEW only).

**Forbidden:** `package_items`, legacy `returns` table, browser-side product writes.

## Sign-off

- Operator:
- Date:
