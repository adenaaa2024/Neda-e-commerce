# Resolver / linkage fields — live vs expected

Reference migration: `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql`  
Resolver: `lib/scanner/resolve-product-for-scanner-item.ts`

## Field matrix

| Field | `expected_packages` | `return_items` | `slip_contents` | Used by resolver / enrichment |
|-------|--------------------:|---------------:|----------------:|------------------------------|
| `expected_product_id` | **missing** | **missing** | — | EP path; `applyReturnItemProductEnrichmentAfterInsert` update |
| `resolved_product_id` | **missing** | **live** | **live** | EP path; map fallback; slip/return patches |
| `resolved_catalog_product_id` | **missing** | **live** | **live** | Listing bridge on all three |
| `identifier_resolution_status` | **missing** | **live** | **live** | Patches; UI review gates |
| `identifier_resolution_confidence` | **missing** | **live** | **live** | Patches |
| `identifier_resolution_source` | **missing** | **missing** | **missing** | Patches (`matched_via`) |
| `identifier_resolution_meta` | **missing** | **missing** | **missing** | Patches (`meta` jsonb) |
| `product_match_status` | **missing** | **missing** | — | Return receive mismatch |
| `product_review_required` | **missing** | **missing** | **missing** | UI + patches |
| `product_resolved_at` | **missing** | **missing** | — | Return enrichment |
| `product_resolved_by` | **missing** | **missing** | — | Return enrichment |
| `expected_item_id` | — | **missing** | — | FK → `expected_packages.id` |
| `scanned_product_id` | — | **missing** | — | Explicit scan path |
| `ocr_text` / `ocr_product_name` / `ocr_confidence` | — | — | **missing** | Slip vision provenance |
| `parsed_asin` / `parsed_fnsku` / `parsed_sku` / `parsed_upc` | — | — | **missing** | Slip parser output |

## Bridge tables (unchanged probe)

| Table | Resolver role | Live status |
|-------|---------------|-------------|
| `product_identifier_map` | FNSKU, ASIN+SKU, UPC bridge | **OK** — all probe columns exist |
| `products` | Direct org+store+sku unique match | **OK** |

## Runtime impact (read-only inference)

1. **`resolveProductForScannerItem` EP branch** — queries `expected_packages` with `expected_product_id`, `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`. **All missing on `expected_packages`** → EP shortcut never runs; resolution falls through to map/products only.

2. **`applyReturnItemProductEnrichmentAfterInsert`** — UPDATE includes 9+ columns missing on `return_items` → PostgREST error logged; only the 4 existing linkage columns could persist if Postgres accepted partial updates (it does not — whole UPDATE fails).

3. **`enrichSlipContentsProductLinksAfterReplace`** — UPDATE includes `ocr_product_name`, `parsed_*`, `identifier_resolution_source`, `identifier_resolution_meta`, `product_review_required` → **fails**; at most the 4 existing columns would be intended.

## Anomaly

`return_items` and `slip_contents` share the **same 4-column subset** (matching `amazon_inventory_ledger` resolution shape from `20260620_product_identifier_map_ledger_enrichment.sql`) while **`expected_packages` has none** of the migration package. This is **not** consistent with a successful single transaction of `20260717120000`. Treat as **partial / out-of-band DDL** until `information_schema` is confirmed on the host.
