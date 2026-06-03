# Schema / function / view plan

## Migrations (probe-based)

- `20260820120000_expected_packages_resolver_columns.sql`: staging=undefined original=undefined → **undefined**
- `20260827160000_expected_packages_tracking_group_allocation.sql`: staging=undefined original=undefined → **undefined**
- `20260828120000_removal_carrier_normalization_views.sql`: staging=undefined original=undefined → **undefined**
- `20260829120000_expected_receive_split.sql`: staging=undefined original=undefined → **undefined**
- `20260830120000_expected_receive_split_item_level.sql`: staging=undefined original=undefined → **undefined**

## Functions

- `normalize_removal_tracking_operational`: **unknown**
- `normalize_removal_carrier_operational`: **unknown**
- `rebuild_expected_packages_from_removals`: **unknown**
- `rebuild_removal_item_allocations`: **unknown**
- `receive_expected_item_with_split`: **unknown**
- `allocate_expected_item_unit`: **unknown**
- `allocate_expected_items_for_return_item_ids`: **unknown**
- `release_expected_item_unit`: **unknown**
- `move_expected_item_unit`: **unknown**

## Views

- `v_inventory_item_status`: **unknown** — 
- `v_scanned_items_counted`: **unknown** — 
- `v_inventory_status`: **unknown** — 

## schema_migrations delta (if available)

Staging versions: 0
Original versions: 0

Phase1 files to verify applied on original:
- 20260820120000_expected_packages_resolver_columns.sql
- 20260827160000_expected_packages_tracking_group_allocation.sql
- 20260828120000_removal_carrier_normalization_views.sql
- 20260829120000_expected_receive_split.sql
- 20260830120000_expected_receive_split_item_level.sql
