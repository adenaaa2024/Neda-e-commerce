# Inventory Item Status (identify gate)

**Status:** **PASS**

| Check | Result | Detail |
|-------|--------|--------|
| alias_fetchInventoryItemStatusForNeda | PASS | inventory read path |
| ui_inventory_rows | PASS | inventory item status table |
| ui_expected_scanned_status_cols | PASS | expected/scanned/status |
| ui_product_linkage_block | PASS | linkage on rows |
| ui_unmapped_label | PASS | No product link yet |
| unresolved_shows_unmapped | PASS | No product link yet |
| stale_refs_zero | PASS | {"package_items":0,"returns_table":0,"packages_package_number_select":0,"pallets_photo_url_select":0} |
| staging_db | PASS | staging service role |
| db_v_inventory_item_status | PASS | ok |
| db_v_inventory_status_optional | PASS | ok (package-level chips) |
| db_fetchVInventoryStatusForScanCode | PASS | rows=3 field=tracking_number |
| db_fetchVInventoryItemStatusLinesExact | PASS | rows=3 |
