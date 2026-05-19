# Validation results — SCANNER-NEDA-02

| Check | Result | Evidence |
|-------|--------|----------|
| Read-only probe (no writes) | **Pass** | OpenAPI GET + `limit=0` SELECT only |
| `products` core resolver select | **Pass** | `id, product_name, sku, asin, fnsku, upc_code` |
| `product_identifier_map` bridge select | **Pass** | `product_id, seller_sku, fnsku, asin, upc_code, deleted_at` |
| `RETURN_LIST_SELECT` | **Pass** | Full string probe |
| `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` | **Fail** | `expected_item_id` does not exist |
| `RETURN_LIST` + 4 partial linkage cols | **Pass** | Subset only |
| `EP_DETAIL_SELECT` | **Pass** | |
| `EP_SELECT` (as in repo) | **Fail** | `expected_packages.asin` does not exist |
| `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` | **Fail** | `identifier_resolution_status` (first linkage miss) |
| `EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT` | **Fail** | `asin` |
| `expected_packages` linkage columns (11) | **Fail** | 0/11 present |
| `return_items` linkage columns (13) | **Partial** | 4/13 present |
| `slip_contents` linkage columns (15) | **Partial** | 4/15 present |
| `slip_contents.notes` | **Fail** | Column absent |
| Migration `20260717120000` fully applied | **Fail** | EP block entirely missing; RI/SC incomplete |

## PostgREST error samples

- `column return_items.expected_item_id does not exist`
- `column expected_packages.resolved_product_id does not exist`
- `column expected_packages.asin does not exist`
- `column slip_contents.ocr_text does not exist`
