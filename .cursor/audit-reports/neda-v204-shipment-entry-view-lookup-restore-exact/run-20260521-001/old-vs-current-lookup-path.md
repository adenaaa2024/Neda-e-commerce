# Old vs current lookup path (V204)

## Shipment Entry surface
- Route: `/scanner/operator-mobile/scan` — header **Shipment Entry**
- Gate handler: `runIdentificationGateSearch` in `app/scanner/operator-mobile/scan/page.tsx`

## Previous (broken) production path
- `lookupShipmentEntryScanCode` could return `found_tracking` / package barcode hits
- `resolveInventoryGateVisualStatus` returned `manual_new` when `inventory_rows.length === 0`
- Gate treated **any** `vis === "manual_new"` as off-manifest → `identifyGatePhase = "new"` (create pallet/box)

## Current (V204) path
1. `fetchVInventoryStatusForScanCode` — `v_inventory_status` then `v_inventory_item_status` (fnsku → sku → tracking → slip)
2. `resolveOperatorBarcode` (tracking → package → slip → pallet; **no item**)
3. `fetchExpectedPackagesForTracking` when tracking barcode matches but view empty
4. `fetchExpectedPackageDetailRowsForParent` EP fallback
5. Package/slip synthetic inventory rows from `packages`
6. `isShipmentEntryOffManifest` — only `not_found` + unknown barcode + zero rows → create flow

## OFF MANIFEST decision
- Badge: `identifyGateStatusBadgeLabel("manual_new")` → **Off manifest**
- Copy: `identifyGateInventoryVisual === "manual_new"` + off-manifest helper → create entity UI
- V204: production gate uses `isShipmentEntryOffManifest(gateLookup)` (matches demo mode)

## Endpoints / modules
| Layer | Symbol |
|-------|--------|
| Canonical lookup | `lookupShipmentEntryScanCode` — `lib/scanner/shipment-entry-lookup.ts` |
| View reads | `fetchVInventoryStatusForScanCode` — `lib/scanner/v-inventory-status.ts` |
| Barcode tables | `resolveOperatorBarcode` — `lib/scanner/operator-resolve-barcode.ts` |
| Gate UI | `runIdentificationGateSearch` — scan `page.tsx` |

## Wiring proof
- Gate calls lookup: yes
- Off-manifest guard: yes
