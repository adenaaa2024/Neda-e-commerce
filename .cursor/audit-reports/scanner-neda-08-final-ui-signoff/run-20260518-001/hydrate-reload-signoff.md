# Hydrate / reload from `return_items`

## Server action

`listOperatorPackageItemsForPackageAction` (`operator-store-actions.ts`):

- SELECT from `return_items` (item-scan column set)
- JOIN logic: `slipContentIdForReturnItemBarcode` + `resolveItemBarcodeAgainstSlipRows`
- Returns `OperatorPackageItemRow[]` with `slip_content_id`, `scanned_barcode`, `match_kind`

## Client hook

`scan/page.tsx` — `packageItemsHydrationNonce` bumps after save; effect calls list action when `flowPhase` + `itemScanPackageId` set.

## Fixture probe

| Metric | Value |
|--------|-------|
| `return_items` on `9528d923-…` | **3** rows |
| NEDA-06 smoke row present | **Yes** |
| Barcode ↔ slip match | **single** (`X004N9OS4J`) |

## Conclusion

**PASS** — reload hydrates scanned units from `return_items`, not `package_items`.
