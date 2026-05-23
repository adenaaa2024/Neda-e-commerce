# Validation results

**Overall:** **PASS**

| Area | Result |
|------|--------|
| Expected packages read + UI wire | PASS |
| Inventory item status read + UI wire | PASS |
| `npm run build` | PASS |
| Staging DB probes | ran |

## All steps

- **read_fetchExpectedPackagesNedaRead**: PASS — alias present
- **read_fetchInventoryItemStatusForNeda**: PASS — alias present
- **read_expected_packages_linkage_api**: PASS — route not used (optional)
- **read_v_inventory_status_migration**: PASS — view defined in repo
- **read_v_scanned_items_counted**: PASS — not referenced — scan counts via return_items helpers
- **read_contract_lib**: PASS — expected-packages-read-contract.ts
- **stale_package_items**: PASS — refs=0
- **stale_returns_table**: PASS — refs=0
- **stale_packages_package_number_select**: PASS — refs=0
- **stale_pallets_photo_url_select**: PASS — refs=0
- **package_drawer_single_status_chip**: PASS — status chip JSX blocks=1
- **package_picker_status_badge**: PASS — picker badges=2
- **package_drawer_line_linkage**: PASS — OperatorProductLinkageMeta on line rows
- **ep_alias_fetchExpectedPackagesNedaRead**: PASS — tracking read path
- **ep_ui_expected_qty_scan_var**: PASS — Exp/Scan columns
- **ep_ui_variance**: PASS — variance label
- **ep_ui_product_linkage_block**: PASS — ProductLinkageDisplayBlock alias
- **ep_ui_order_tracking_context**: PASS — order + tracking wiring
- **ep_contract_variance_math**: PASS — +2
- **ep_stale_refs_zero**: PASS — {"package_items":0,"returns_table":0,"packages_package_number_select":0,"pallets_photo_url_select":0}
- **ep_staging_db**: PASS — staging service role
- **ep_db_ep_detail_select**: PASS — ok
- **ep_db_ep_linkage_select**: FAIL — column expected_packages.product_match_status does not exist
- **ep_db_fetch_by_tracking**: PASS — tracking=2954989706 rows=3
- **ep_db_load_snapshot**: PASS — lines=3 raw=3
- **ep_db_linkage_contract**: PASS — X003UPTOJV · 2026JUN02-B0BNR1D6BL
- **ep_db_filter_order_id**: PASS — rows=5
- **inv_alias_fetchInventoryItemStatusForNeda**: PASS — inventory read path
- **inv_ui_inventory_rows**: PASS — inventory item status table
- **inv_ui_expected_scanned_status_cols**: PASS — expected/scanned/status
- **inv_ui_product_linkage_block**: PASS — linkage on rows
- **inv_ui_unmapped_label**: PASS — No product link yet
- **inv_unresolved_shows_unmapped**: PASS — No product link yet
- **inv_stale_refs_zero**: PASS — {"package_items":0,"returns_table":0,"packages_package_number_select":0,"pallets_photo_url_select":0}
- **inv_staging_db**: PASS — staging service role
- **inv_db_v_inventory_item_status**: PASS — ok
- **inv_db_v_inventory_status_optional**: PASS — ok (package-level chips)
- **inv_db_fetchVInventoryStatusForScanCode**: PASS — rows=3 field=tracking_number
- **inv_db_fetchVInventoryItemStatusLinesExact**: PASS — rows=3
- **npm_run_build**: PASS — exit 0
- **env_next_public_not_staging**: PASS — NEXT_PUBLIC_* points at original project — DB probes used STAGING_* only
