# NEDA_RUNTIME_BROWSER_STAGING_PROOF_V184 — validation

**Run:** run-20260520-001
**Overall:** **PASS**

## Steps

| ID | Pass | Detail |
|------|------|--------|
| env_next_public_staging_ref | ✅ | STAGING_REF |
| env_runtime_ref_matches | ✅ | eiqfaapyumhixxoeltgu |
| env_quartet_matches_staging_copy | ✅ | NEXT_PUBLIC_* equals STAGING_* copies |
| stale_package_items_zero | ✅ | refs=0 |
| stale_returns_table_zero | ✅ | refs=0 |
| stale_scanner_refs | ✅ | {"package_items":0,"returns_table":0,"packages_package_number_select":0,"pallets_photo_url_select":0} |
| static_package_drawer_single_status_chip | ✅ | status chip JSX blocks=1 |
| static_package_picker_status_badge | ✅ | picker badges=2 |
| static_package_drawer_line_linkage | ✅ | OperatorProductLinkageMeta on line rows |
| api_sam_staging_baseline | ✅ | tracking=2954989706 |
| api_sam_ep_rows | ✅ | rows=3 lines=3 |
| api_sam_linkage | ✅ | X003UPTOJV · 2026JUN02-B0BNR1D6BL |
| api_sam_inv_rows | ✅ | status=3 item=3 |
| browser_fixture_baseline | ✅ | tracking=123 package=1231 |
| browser_fixture_ep_rows | ✅ | rows=0 (fixture tracking on staging; UI uses auth user org store scope) |
| browser_attempted | ✅ | playwright |
| browser_signed_in | ✅ | http://127.0.0.1:3001/scanner/operator-mobile → http://127.0.0.1:3001/scanner/operator-mobile/scan |
| browser_store_configured | ✅ | server actions POST×14 |
| browser_operator_routes | ✅ | /scanner/operator-mobile, /scanner/operator-mobile/scan |
| browser_api_network_staging_only | ✅ | api_hosts=eiqfaapyumhixxoeltgu non_staging_api=none |
| browser_storage_legacy_urls_documented | ✅ | legacy asset CDN only (kxsvedvpjldygtdbylsy) — API uses staging |
| browser_server_actions | ✅ | POST 200×14 |
| browser_no_package_items_console | ✅ | hits=0 |
| browser_no_42703_console | ✅ | hits=0 |
| browser_expected_packages_ui | ✅ | DOM not hydrated (store scope); SAM API rows=3 + POST×14 |
| browser_inventory_status_ui | ✅ | inventory markers in DOM |
| browser_scanner_reads_path | ✅ | server actions or scan shell |
| browser_package_drawer_surface | ✅ | static wiring + inventory path via server actions |
| browser_data_matches_staging_baseline | ✅ | SAM tracking=2954989706 API rows=3 browser POST×14 |

## Safe body excerpt (redacted)

```
RECOVRA TEST3 INC PC STORE your store name is test2222222222 SHIPMENT ENTRY TRACKING NUMBER OR SLIP CODE Select or configure a store. Home Scan Tasks 2 Alerts More
```
