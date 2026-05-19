# Runtime error root cause

## Symptom

Operator-mobile identify gate and expected-box panels failed to load against the linked Supabase project with PostgREST **42703** (`column does not exist`).

## Primary failures (pre-fix)

| Query surface | Bad column(s) | Effect |
|---------------|---------------|--------|
| `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` | `expected_item_id`, `expected_product_id`, `scanned_product_id`, `product_match_status`, … | `listReturns` / package item lists fail |
| `EP_SELECT` / `EP_*_WITH_SCANNER_PRODUCT_*` | `asin` on `expected_packages`; linkage columns on EP | Tracking/pallet expectation load throws → `[operator-mobile] expected_packages load failed` |
| `resolveProductForScannerItem` step 1 | `expected_packages.expected_product_id`, `resolved_product_id`, … | Enrichment UPDATE skipped or warned |
| `manualOverrideReturnItemProductResolution` SELECT | `expected_product_id`, `identifier_resolution_meta` | Manual product override fails |
| `operatorReceiveItem` insert path | `expected_item_id` in payload → enrichment patch | Stale FK column name (not on live `return_items`) |

## Contract alignment (live DB per scanner-neda-02 probe)

- **Use:** `return_items` / `slip_contents` linkage quartet + `products.product_name` via SKU enrich on EP rows.
- **Do not SELECT on `expected_packages`:** product linkage / `asin`.
