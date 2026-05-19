# Contract alignment

## Reads (SELECT)

### `return_items`

```
resolved_product_id, resolved_catalog_product_id,
identifier_resolution_status, identifier_resolution_confidence
```

Used in `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` and manual-override load.

`identifier_resolution_source` is **written** on update when the column exists (patch fallback); omitted from list SELECT until full migration.

### `expected_packages`

```
sku, fnsku, disposition, expected_scan_quantity, order_id, tracking_number
```

Detail: `id, …, actual_scanned_count, id_slip_contents` — **no** `asin`, **no** EP linkage columns.

Product display: `enrichExpectedPackageDetailRowsWithCatalogLabels` → `products.product_name` by SKU.

### `slip_contents`

Base line columns + linkage quartet on hydration paths (with server-side select fallbacks in `listOperatorSlipContentsForPackageAction`).

## Writes (UPDATE)

`updateRowWithScannerLinkagePatch` applies core quartet first; drops `identifier_resolution_source` (and other optional keys) if PostgREST reports missing column.

## Resolver

`resolveProductForScannerItem`: `product_identifier_map` → UPC → `products.sku` (org + store). No OCR/title-only match; no product creation.
