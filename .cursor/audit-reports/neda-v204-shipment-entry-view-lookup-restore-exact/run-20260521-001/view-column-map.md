# View column map (staging `eiqfaapyumhixxoeltgu`)

## v_inventory_status
- `carrier`
- `order_id`
- `organization_id`
- `package_date`
- `slip_code`
- `status`
- `store_id`
- `total_expected`
- `total_scanned`
- `tracking_number`

## v_inventory_item_status
- `asin`
- `carrier`
- `expected_qty`
- `fnsku`
- `identifier_resolution_confidence`
- `order_id`
- `organization_id`
- `package_count`
- `package_date`
- `product_id`
- `product_identifier`
- `product_linkage_status`
- `product_name`
- `resolved_catalog_product_id`
- `resolved_product_id`
- `scanned_qty`
- `sku`
- `slip_code`
- `status`
- `store_id`
- `total_expected`
- `total_scanned`
- `tracking_number`
- `upc`
- `variance_qty`

## Identifier columns for gate
| Column | v_inventory_status | v_inventory_item_status |
|--------|-------------------|-------------------------|
| tracking_number | yes | yes |
| id_slip_contents | no | no |
| package_code | no | no |
| total_expected / scanned | yes | yes |

**package_code in view:** NO (carton codes use `packages` via `resolveOperatorBarcode` until DDL approved)
