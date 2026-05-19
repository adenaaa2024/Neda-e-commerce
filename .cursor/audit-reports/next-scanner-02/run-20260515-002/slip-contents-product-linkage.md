# `slip_contents` — OCR + product linkage

## Columns added (migration)

- OCR: `ocr_text`, `ocr_product_name`, `ocr_confidence`
- Parsed identifiers: `parsed_asin`, `parsed_fnsku`, `parsed_sku`, `parsed_upc`
- Resolution: `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_*`, `product_review_required`

## Save flow

- `updateOperatorIntakeBoxPackageAction` still bulk-inserts slip lines (raw manifest + identifiers unchanged).
- On successful insert, `enrichSlipContentsProductLinksAfterReplace` runs asynchronously (`void`):
  - Reloads rows by `package_id` + `sort_index`
  - Sets `ocr_product_name` / `parsed_fnsku` / `parsed_upc` from line payload
  - Runs `resolveProductForScannerItem` per row and PATCHes resolution columns
  - Failures are warn-only

## Resolver inputs for slip

Uses FNSKU / UPC from the line; `description` is passed as `ocr_product_name` metadata only (not used to deterministically pick `products.id`).
