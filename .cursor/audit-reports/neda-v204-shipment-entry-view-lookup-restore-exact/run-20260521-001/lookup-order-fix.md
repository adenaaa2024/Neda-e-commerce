# Lookup order fix (V204)

```
normalized scan code
  → A. v_inventory_status / v_inventory_item_status (fetchVInventoryStatusForScanCode)
  → B. resolveOperatorBarcode (tracking → package → slip → pallet)
  → C. fetchExpectedPackagesForTracking + EP parent fallback
  → D. package/slip synthetic rows from packages table
  → E. isShipmentEntryOffManifest → OFF MANIFEST / create flow only here
```

## UI gate fix
Production `runIdentificationGateSearch` now mirrors demo: create flow only when `isShipmentEntryOffManifest(gateLookup)`.

## Code refs
- `lib/scanner/shipment-entry-lookup.ts` — `lookupShipmentEntryScanCode`, `isShipmentEntryOffManifest`
- `lib/scanner/v-inventory-status.ts` — dual-view query
- `app/scanner/operator-mobile/scan/page.tsx` — gate phase branching
