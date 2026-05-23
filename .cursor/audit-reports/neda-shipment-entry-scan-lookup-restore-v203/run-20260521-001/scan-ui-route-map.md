# Scan UI route map

## Route

| Field | Value |
|-------|--------|
| URL path | `/scanner/operator-mobile/scan` |
| App file | `app/scanner/operator-mobile/scan/page.tsx` |
| Tab | Operator mobile bottom nav → **Scan** |
| Screen title | **Shipment Entry** (`headerTitle = "Shipment Entry"`) |
| Gate CSS scope | `.operator-shipment-entry-gate` |

## Input surface

| UI label | State / handler |
|----------|----------------|
| `Tracking Number or Slip Code` | `scanLine` input, placeholder *Scan, type or upload photo* |
| Search on submit / scan | `runIdentificationGateSearch(code)` |
| Deep link | `?code=` or `?q=` → auto-runs gate search then `router.replace` |

## API / read path (after V203 restore)

| Phase | Call |
|-------|------|
| **Current (restored)** | `lookupShipmentEntryScanCode(supabase, orgId, sessionStoreId, code)` in `lib/scanner/shipment-entry-lookup.ts` |
| Inventory slice | `fetchVInventoryStatusForScanCode` → `v_inventory_item_status` |
| Physical entities | `resolveOperatorBarcode` with `only`: `tracking` → `package` → `slip` → `pallet` (no `item`) |
| EP fallback | `fetchExpectedPackageDetailRowsForParent` / `fetchExpectedPackageDetailRowsByIds` |
| Lines table | `fetchVInventoryItemStatusLinesExact` |
| Expectation snapshot | `loadTrackingExpectationSnapshot` |
| Duplicate pallet | `findOperatorPalletByTrackingNumberAction` + `resumeWorkflowFromExistingPalletRow` |

## Previous (broken) path

| Phase | Call |
|-------|------|
| Primary only | `fetchVInventoryStatusForScanCode` — **fnsku, sku, tracking_number, id_slip_contents only** |
| EP fallback | Inline `fetchExpectedPackageDetailRowsForParent` when view empty |
| **Missing** | `packages.package_code`, pallet barcode, slip via `packages` / `rma_number` unless coincidentally on view |

## UI expected shape

Gate uses local state (not `ShipmentEntryLookupResult` JSON over wire):

- `identifyGatePhase`: `idle` \| `searching` \| `matched` \| `new`
- `identifyGateInventoryVisual`: `new` \| `manual_new` \| `unexpected` \| `in_progress` \| `completed` \| `over_scanned`
- `identifyGateRows`, `identifyGateShipmentLines`, `identifyGateCanonicalTracking`
- `identifyGateEntity`: operator-selected `pallet` \| `package` \| `single_box` \| `item` (post-match — **not** product resolver)

## Not this screen

- `resolveOperatorBarcode(..., { only: "item" })` — item scan phase only
- `resolveProductForScannerItem` / `ProductLinkageDisplayContract` on gate search
- Legacy `/scanner/page.tsx` tracking-only demo
