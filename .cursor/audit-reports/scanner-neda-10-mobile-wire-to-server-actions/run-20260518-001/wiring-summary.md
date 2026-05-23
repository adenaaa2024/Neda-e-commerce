# Wiring summary — SCANNER-NEDA-10

**Run:** `run-20260518-001`  
**Scan page:** `app/scanner/operator-mobile/scan/page.tsx`

## Server actions (P0)

| Action | UI binding |
|--------|------------|
| `listOperatorSlipContentsForPackageAction` | `itemInspectionSlipLines` effect (flowPhase `items`); slip order/conflict refresh on package_scan |
| `listOperatorPackageItemsForPackageAction` | Hydrate `packageItemScanState` via `aggregateOperatorPackageItemRows` on mount/reload (`packageItemsHydrationNonce`) |
| `insertOperatorPackageItemAction` | `saveItemUnitModal` on modal save |

## Client resolver

| Helper | Usage |
|--------|--------|
| `resolveItemBarcodeAgainstSlipRows` | `handleItemBarcodeScan`, `saveItemUnitModal` (re-match when preset null) |

## Static wiring gates

```json
{
  "import_listOperatorSlipContentsForPackageAction": true,
  "import_listOperatorPackageItemsForPackageAction": true,
  "import_insertOperatorPackageItemAction": true,
  "import_resolveItemBarcodeAgainstSlipRows": true,
  "effect_hydrate_package_items": true,
  "effect_slip_lines_itemInspection": true,
  "saveItemUnitModal_insert": true,
  "saveItemUnitModal_resolve": true,
  "handleItemBarcodeScan_resolve": true,
  "hydration_nonce_bump": true,
  "itemInspectionSlipCells_ui": true,
  "progressive_row_styling": true,
  "sticky_header_items": true
}
```

## Save sequence (contract)

1. Scan → `resolveItemBarcodeAgainstSlipRows` → unit modal  
2. Save → `insertOperatorPackageItemAction`  
3. Success → `setPackageItemsHydrationNonce(n+1)` → re-fetch `listOperatorPackageItemsForPackageAction`

## UI preservation

- Sticky items header, compact slip rows, progressive white→green via `itemInspectionSlipLinePresentation` — unchanged.
