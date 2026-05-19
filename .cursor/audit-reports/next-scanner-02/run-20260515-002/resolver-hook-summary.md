# Resolver + hook summary

## `resolveProductForScannerItem`

- **Path:** `lib/scanner/resolve-product-for-scanner-item.ts`
- **Input:** `organization_id`, `store_id`, optional `expected_item_id`, identifiers (`asin`, `fnsku`, `msku`/`sku`, `upc`), optional OCR/raw (ignored for deterministic matching), `source_table`, `source_row_id` (audit meta only).
- **Order:** (1) `expected_packages` product columns if present, (2) `product_identifier_map` by FNSKU then ASIN+seller_sku, (3) UPC map — multiple `product_id` → ambiguous; single UPC hit → resolved with `review_required: true`, (4) direct `products` by org+store+sku when exactly one row.
- **Output:** `resolved_product_id`, optional `resolved_catalog_product_id`, `status`, `confidence`, `matched_via`, `review_required`, `meta`.
- **Blocked behaviors:** no product creation, no OCR/title-only match, no Amazon/OpenAI, no silent overwrite of expected product on the expectation row.

## Save-path helpers

- `lib/scanner/apply-return-item-product-enrichment.ts` — post-insert `return_items` update; never throws.
- `lib/scanner/enrich-slip-contents-product-links.ts` — post-replace `slip_contents` per-row updates; never throws.

## Hook (display)

- **Path:** `hooks/use-scanner-product-resolution.ts`
- Wraps `scannerProductResolutionBadges` from `lib/scanner/product-resolution-badges.ts` with stable `useMemo` deps for scanner list rows.

## Optional server action (future)

No separate `"use server"` action file was added to avoid widening the API surface; resolver is imported from server modules (`actions.ts`, `operator-store-actions.ts`) as needed.
