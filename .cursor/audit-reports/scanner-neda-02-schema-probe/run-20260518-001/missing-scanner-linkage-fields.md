# Missing scanner / Neda linkage fields (live DB)

“Neda” in this audit = **NEXT-SCANNER-02 product linkage** expected by scanner UI, resolver, and `20260717120000_scanner_product_linkage_columns.sql` (not claim-engine `created_by` / RLS work).

## `expected_packages` — all 11 missing

| Column | PostgREST probe |
|--------|-----------------|
| `expected_product_id` | `42703` does not exist |
| `resolved_product_id` | `42703` |
| `resolved_catalog_product_id` | `42703` |
| `identifier_resolution_status` | `42703` |
| `identifier_resolution_confidence` | `42703` |
| `identifier_resolution_source` | `42703` |
| `identifier_resolution_meta` | `42703` |
| `product_match_status` | `42703` |
| `product_review_required` | `42703` |
| `product_resolved_at` | `42703` |
| `product_resolved_by` | `42703` |

## `return_items` — 9 missing (4 present)

**Present:** `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`

**Missing:**

| Column | PostgREST probe |
|--------|-----------------|
| `expected_item_id` | `42703` |
| `expected_product_id` | `42703` |
| `scanned_product_id` | `42703` |
| `identifier_resolution_source` | `42703` |
| `identifier_resolution_meta` | `42703` |
| `product_match_status` | `42703` |
| `product_review_required` | `42703` |
| `product_resolved_at` | `42703` |
| `product_resolved_by` | `42703` |

## `slip_contents` — 10 missing (4 present)

**Present:** same quartet as `return_items`

**Missing:** `ocr_text`, `ocr_product_name`, `ocr_confidence`, `parsed_asin`, `parsed_fnsku`, `parsed_sku`, `parsed_upc`, `identifier_resolution_source`, `identifier_resolution_meta`, `product_review_required`

## Additional code/schema drift (not in 20260717120000)

| Column | Expected by | Live DB |
|--------|-------------|---------|
| `expected_packages.asin` | `EP_SELECT` in `operator-tracking-expectations.ts` | **missing** |
| `slip_contents.notes` | `types/database.types.ts`, migration `20260641130000` | **missing** |

## Conclusion

Migration **`20260717120000` is not fully applied** on the linked project. Extended app selects and enrichment UPDATE paths **must not** be assumed production-safe until apply + re-probe.
