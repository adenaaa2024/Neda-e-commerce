# Reload / hydrate verification

## Method

Post-insert SELECT on `return_items` using the same column list as `listOperatorPackageItemsForPackageAction`:

`id, fnsku, sku, product_identifier, conditions, expiration_date, batch_number, photo_evidence, created_at`

Filtered by `package_id` + `organization_id`, `deleted_at IS NULL`, ordered by `created_at`.

## Result

- Inserted id `ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663` present in hydrated set (3 rows total for package).
- Scanned barcode from row: `X004N9OS4J`

## UI expectation

After save, `scan/page.tsx` bumps `packageItemsHydrationNonce` → re-fetches via `listOperatorPackageItemsForPackageAction` (still backed by `return_items`).

## Conclusion

**PASS** — reload query hydrates the new unit.
