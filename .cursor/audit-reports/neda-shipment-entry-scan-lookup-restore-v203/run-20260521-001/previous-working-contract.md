# Previous working contract

## What worked before

1. **`resolveOperatorBarcode`** (`lib/scanner/operator-resolve-barcode.ts`) — documented order: **Tracking → Package → Slip → Pallet → Item**, including:
   - `packages.package_code`
   - `packages.id_slip_contents`
   - `packages.tracking_number` (normalized)
   - `packages.rma_number` (slip)
   - `pallets.pallet_number` + inbound tracking via `findPalletByTrackingNormalized`

2. **`runResolve`** on the same scan page still calls `resolveOperatorBarcode` for pallet/box flows outside the gate.

## What regressed (NEDA-17+ inventory view wiring)

Identify gate (`runIdentificationGateSearch`) was rewired to **`fetchVInventoryStatusForScanCode` only**:

```ts
// v-inventory-status.ts — gate columns only:
fnsku → sku → tracking_number → id_slip_contents
```

Effects:

| Code type | Before (barcode resolver) | After (view-only gate) |
|-----------|---------------------------|-------------------------|
| Carrier tracking | ✅ EP + view | ✅ |
| Slip / `id_slip_contents` | ✅ package + view | ✅ if on view |
| **Carton `package_code`** | ✅ `packages` | ❌ not in view |
| **Pallet barcode** | ✅ `pallets` | ❌ unless tracking on pallet matches |
| Product SKU/FNSKU at gate | item tier (wrong screen) | Accidentally matched via view |

## Repo evidence

- `scanner-neda-17-expected-packages-inventory-views` audit: gate primary read = `fetchVInventoryStatusForScanCode`
- `ui-integration-map` (v165): gate listed both inventory fetch **and** `resolveOperatorBarcode(..., { only: "tracking" })` — implementation dropped package/pallet leg
- Migration `20260511140000_packages_package_code_slip_code.sql`: `package_code` on `packages`, not added to `v_inventory_item_status`

## V203 restore strategy

Orchestrate in **`lookupShipmentEntryScanCode`**:

1. Inventory view (manifest / expected lines)
2. `resolveOperatorBarcode` without `item`
3. Hydrate inventory rows from package/pallet tracking when view empty
4. Keep existing gate UI state machine unchanged
