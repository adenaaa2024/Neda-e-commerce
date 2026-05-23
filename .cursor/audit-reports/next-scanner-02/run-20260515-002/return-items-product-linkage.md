# `return_items` — product linkage

## Columns added (migration)

- `expected_item_id` → `expected_packages.id`
- `expected_product_id`, `scanned_product_id`, `resolved_product_id`, `resolved_catalog_product_id`
- Full `identifier_resolution_*` + `product_match_status` + `product_review_required` + `product_resolved_at` / `product_resolved_by`

## Save flow

- `app/scanner/operator-mobile/item-actions.ts` passes `expected_item_id: epId` on `ReturnInsertPayload`.
- `app/returns/actions.ts` `insertReturn` persists core row first, then `applyReturnItemProductEnrichmentAfterInsert`:
  - Runs `resolveProductForScannerItem`
  - Copies expected product from `expected_packages` when linked
  - Sets `product_match_status` to `mismatch` when expected and resolved products both exist and differ (expected row is not mutated)
  - Never fails the overall save if enrichment update errors (warn-only)

## List reads

- Default `RETURN_LIST_SELECT` unchanged for backward compatibility.
- Use `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` after migration when the Returns list UI should show linkage columns.
