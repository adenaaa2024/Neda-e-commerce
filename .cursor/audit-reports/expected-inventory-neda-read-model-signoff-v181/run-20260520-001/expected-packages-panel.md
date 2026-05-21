# Expected Packages / inventory summary

**Status:** **PASS**

| Check | Result | Detail |
|-------|--------|--------|
| alias_fetchExpectedPackagesNedaRead | PASS | tracking read path |
| ui_expected_qty_scan_var | PASS | Exp/Scan columns |
| ui_variance | PASS | variance label |
| ui_product_linkage_block | PASS | ProductLinkageDisplayBlock alias |
| ui_order_tracking_context | PASS | order + tracking wiring |
| contract_variance_math | PASS | +2 |
| stale_refs_zero | PASS | {"package_items":0,"returns_table":0,"packages_package_number_select":0,"pallets_photo_url_select":0} |
| staging_db | PASS | staging service role |
| db_ep_detail_select | PASS | ok |
| db_ep_linkage_select | FAIL | column expected_packages.product_match_status does not exist |
| db_fetch_by_tracking | PASS | tracking=2954989706 rows=3 |
| db_load_snapshot | PASS | lines=3 raw=3 |
| db_linkage_contract | PASS | X003UPTOJV · 2026JUN02-B0BNR1D6BL |
| db_filter_order_id | PASS | rows=5 |
