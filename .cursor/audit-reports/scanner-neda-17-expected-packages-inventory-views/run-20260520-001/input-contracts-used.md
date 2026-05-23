# Input contracts used

| Source | Status |
|--------|--------|
| NEDA_EXPECTED_PACKAGES_INVENTORY_VIEWS_HANDOFF_V179.md | **MISSING** |
| expected-packages-neda-read-contract.md | **MISSING** — `lib/scanner/expected-packages-read-contract.ts` |
| neda-inventory-read-contract.md | **MISSING** — `lib/scanner/v-inventory-status.ts` |
| .ai-memory/NEDA_HANDOFF.md | not in repo |
| .ai-memory/DATABASE_CONTRACT.md | not in repo |

## Implemented read surfaces

- `expected_packages`: `EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT` / `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` with column fallback
- `return_items`: scanned counts via `fetchReturnItemsScannedBySkuFnsku*` (read-only)
- `slip_contents`: server actions (NEDA-16 baseline)
- `v_inventory_item_status`: `fetchVInventoryStatusForScanCode` + line table on identify gate

## Static gates

- **forbidden_package_items**: PASS — refs=0
- **forbidden_returns_table**: PASS — refs=0
- **forbidden_products_insert**: PASS — refs=0
- **forbidden_browser_writes**: PASS — refs=0
- **handoff_v179_doc**: FAIL — MISSING — used inline task spec + libs
- **ep_read_contract_doc**: PASS — lib fallback: C:\Users\Christian\ecommerce-os\lib\scanner\expected-packages-read-contract.ts
- **inv_read_contract_doc**: PASS — lib fallback: C:\Users\Christian\ecommerce-os\lib\scanner\v-inventory-status.ts
- **ui_v_inventory_item_status_read**: PASS — identify gate primary read
- **ui_identify_gate_variance**: PASS — shipment line table
- **ui_identify_gate_linkage_meta**: PASS — gate lines
- **ui_expected_pkg_variance**: PASS — expected tables
- **ui_expected_product_linkage**: PASS — TrackingOperatorLine linkage
- **ui_unmapped_label**: PASS — OperatorProductLinkageMeta
- **ui_needs_review_label**: PASS — OperatorProductLinkageMeta
- **ui_save_insert_operator**: PASS — approved save path
- **ui_no_ep_client_write**: PASS — no EP writes from scan page
- **lib_ep_contract**: PASS — C:\Users\Christian\ecommerce-os\lib\scanner\expected-packages-read-contract.ts
- **lib_tracking_enrich**: PASS — snapshot enrich
- **lib_v_inv**: PASS — C:\Users\Christian\ecommerce-os\lib\scanner\v-inventory-status.ts
- **null_product_id_safe**: PASS — No product link yet
- **ambiguous_merge**: PASS — Needs review
- **variance_format**: PASS — +2 over
- **db_ep_detail_select**: PASS — ok
- **db_ep_linkage_select**: FAIL — column expected_packages.identifier_resolution_status does not exist
- **db_v_inventory_item_status**: PASS — ok
- **db_inventory_scan_helper**: FAIL — SKIP — no STORE_ID
