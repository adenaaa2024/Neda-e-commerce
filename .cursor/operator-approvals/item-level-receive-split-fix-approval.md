# Item-level receive split fix — operator approval

**Scope:** Staging DDL + PL/pgSQL unit allocation functions + app wiring (`operatorReceiveItem`, delete/move rollback).  
**Staging ref:** `eiqfaapyumhixxoeltgu`  
**Original ref:** `kxsvedvpjldygtdbylsy` (parity only after staging PASS)

| Flag | Default | Meaning |
|------|---------|---------|
| `APPROVED_TO_RUN_STAGING` | `false` | Allow apply script / direct Postgres on staging |
| `APPROVED_ITEM_LEVEL_RECEIVE_SPLIT_FIX` | `false` | Approve full fix: DDL + functions + app + smokes |

## Change summary (when approved)

1. Additive `expected_packages` columns: `parent_expected_package_id`, `receive_scope_key`, `allocated_package_id`, `allocated_pallet_id`, `receive_entity_type`.
2. Replace quantity-counter receive path with unit functions:
   - `allocate_expected_item_unit(...)`
   - `release_expected_item_unit(...)`
   - `move_expected_item_unit(...)`
3. `actual_scanned_count` becomes **derived** (view/trigger cache); app stops dual-write.
4. Wire `operatorReceiveItem` / `deleteReturn` / `updateReturn` (package move).

## Preconditions

- [ ] Read audit `.cursor/audit-reports/item-level-receive-split-fix-plan/<run_id>/`
- [ ] Read prior model plan `.cursor/audit-reports/item-level-return-expected-split-model-plan/20260528T104159Z/`
- [ ] `20260717120000_scanner_product_linkage_columns.sql` applied on staging (`return_items.expected_item_id`)
- [ ] No production DB writes
- [ ] No `package_items`, no legacy `returns` queries
- [ ] Rollback SQL prepared before smoke writes

## Explicit exclusions

- No `quantity_entered` on `return_items`
- No auto product create from scan
- No original/production apply until staging signoff

## Sign-off (fill when approving)

```
APPROVED_TO_RUN_STAGING=false
APPROVED_ITEM_LEVEL_RECEIVE_SPLIT_FIX=false
Approved by:
UTC date:
```
