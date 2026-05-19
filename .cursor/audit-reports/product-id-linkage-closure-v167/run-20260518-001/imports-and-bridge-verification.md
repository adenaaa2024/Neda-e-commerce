# Imports and identifier bridge

## `product_identifier_map` (staging)

- **31 columns**; bridge keys present: `product_id`, `catalog_product_id`, `seller_sku`, `asin`, `fnsku`, `upc_code`, `store_id`, `organization_id`.
- Resolver (`resolveProductForScannerItem`) and ledger enrich (`lib/inventory-ledger-identifier-enrich.ts`) read/write this table.
- Import path: `scripts/import-product-identity.ts`, `app/(admin)/imports/import-actions.ts` — upserts map rows; **does not** auto-create products outside import rules.

## `products` (staging)

- Canonical target for `resolved_product_id` FK (when set).
- Identifiers: `asin`, `fnsku`, `sku`, `upc_code`.

## `catalog_products` (staging)

- **30 columns**; includes `product_id`, `linked_product_id`, `seller_sku`, `asin`, `fnsku`.
- Listing bridge for `resolved_catalog_product_id` when map row carries `catalog_product_id`.

## `raw_report_uploads` (staging)

- **22 columns** — job metadata (`report_type`, `status`, file hashes, etc.).
- No line-level `product_id`; identity flows through staged imports into map/products.

## `claim_reference_edges` (staging)

- **26 columns** — graph edges between claim artifacts.
- Links entities via `from_source_table` / `from_source_row_id` (e.g. `return_items`), not denormalized `product_id`.
- Product closure for claims is **join-time**, not edge-column.

## `listing_raw_rows`

- Not exposed in PostgREST OpenAPI on this project — cannot verify via REST probe.

## Verdict

| Path | Product linkage |
|------|-----------------|
| Product identity import → map → products | **PASS** (bridge populated separately from scanner) |
| Scanner resolver consumes map | **PASS** (code) |
| Import tables carry scanner `resolved_*` cols | **N/A** — correct separation |
