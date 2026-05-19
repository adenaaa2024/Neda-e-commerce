# Recommended safe SELECTs — scanner UI (live DB)

Probed with PostgREST `limit=0` on project `kxsvedvpjldygtdbylsy`. **PASS** = safe today; **FAIL** = do not use until migration apply.

## Safe today

### `expected_packages`

```text
# Lightweight tracking snapshot (fix: remove asin until column exists)
sku, fnsku, disposition, expected_scan_quantity, order_id, tracking_number
```

```text
# Detail / item scan (used by operator-tracking-expectations fallback)
id, sku, fnsku, disposition, expected_scan_quantity, actual_scanned_count, order_id, tracking_number, id_slip_contents
```

Constants: `EP_DETAIL_SELECT` in `lib/scanner/operator-tracking-expectations.ts` — **PASS**.

**Do not use** raw `EP_SELECT` as committed (`sku, fnsku, asin, disposition, ...`) — **`asin` fails** on live DB.

### `return_items`

```text
# Items tab list (returns-constants.ts)
id, organization_id, lpn, rma_number, marketplace, item_name,
asin, fnsku, sku, product_identifier,
conditions, status, notes, photo_evidence,
expiration_date, batch_number, store_id, pallet_id, package_id, order_id,
created_by, updated_by, created_at, updated_at, estimated_value, deleted_at,
stores(name,platform)
```

Constant: `RETURN_LIST_SELECT` — **PASS**.

```text
# Optional: add only columns that exist today
..., resolved_product_id, resolved_catalog_product_id,
identifier_resolution_status, identifier_resolution_confidence
```

**Do not use** `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` — fails on `expected_item_id`.

### `slip_contents`

```text
id, package_id, organization_id, store_id, slip_code, package_code,
rma_number, upc, fnsku, description, quantity, condition,
sort_index, order_id, conflicting_order_id, created_at, created_by
```

```text
# If reading linkage written by partial DDL only:
id, resolved_product_id, resolved_catalog_product_id,
identifier_resolution_status, identifier_resolution_confidence
```

**Do not select** `notes`, `ocr_*`, `parsed_*`, `product_review_required`.

### `products` (resolver direct match)

```text
id, organization_id, store_id, sku, asin, fnsku, upc_code, product_name, deleted_at
```

### `product_identifier_map` (resolver bridge)

```text
product_id, catalog_product_id, fnsku, asin, seller_sku, upc_code
```

With filters: `organization_id`, optional `store_id` scope, `deleted_at IS NULL` in app code.

---

## Not safe until `20260717120000` applied

| Constant / usage | Reason |
|------------------|--------|
| `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` | Missing 9 linkage columns |
| `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` | Missing all EP linkage columns |
| `EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT` | Fails on `asin` then linkage |
| `resolveProductForScannerItem` EP `.select(...)` | `expected_product_id` etc. missing on EP |
| Slip enrichment UPDATE patch | Majority of columns missing |

---

## After migration apply (re-probe)

Switch read paths to:

- `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT`
- `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT`
- `EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT` **only if** `expected_packages.asin` is added or removed from `EP_SELECT`

Re-run this audit probe or `scripts/next-scanner-04-staging-e2e.ts` preflight.
