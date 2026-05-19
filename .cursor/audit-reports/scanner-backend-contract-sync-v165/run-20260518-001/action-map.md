# Action map — operator-mobile scanner

Module: `app/scanner/operator-mobile/_components/operator-store-actions.ts` (`"use server"`)  
Supplement: `app/scanner/operator-mobile/item-actions.ts`

Legend: **R** = read, **W** = write

---

## Neda-critical (item scan + slip)

| Action | Input (summary) | Output (success) | Output (failure) | DB |
|--------|-----------------|------------------|------------------|-----|
| **`listOperatorSlipContentsForPackageAction`** | `requestedOrganizationId`, `packageId`, `storeId?` | `{ ok: true, rows[] }` | `{ ok: false, message }` | R: packages, slip_contents |
| **`listOperatorPackageItemsForPackageAction`** | same | `{ ok: true, rows: OperatorPackageItemRow[] }` | `{ ok: false, message }` | R: packages, return_items, slip_contents (via list slip) |
| **`insertOperatorPackageItemAction`** | See backend-contract §4 | `{ ok: true, id }` | `{ ok: false, message }` | R: packages, slip_contents?; W: return_items |
| **`updateOperatorIntakeBoxPackageAction`** | `UpdateOperatorIntakeBoxPackageInput` | `{ ok: true, ...flags }` | `{ ok: false, message, duplicatePackingSlip? }` | R/W: packages; W: slip_contents replace; R/W: pallets optional |
| **`saveOperatorSlipVisionAction`** | alias of update | same | same | same |
| **`saveOperatorPackageAction`** | alias of update | same | same | same |
| **`checkOperatorSlipCodeDuplicateAction`** | `requestedOrganizationId`, `slipCode`, `excludePackageId` | `{ ok: true, duplicate: false }` or `{ duplicate: true, slipCode, otherPackageCode, message }` | `{ ok: false, error }` | R: packages |

### `insertOperatorPackageItemAction` — error messages

| Condition | `message` |
|-----------|-----------|
| Not signed in | `Not signed in.` |
| Invalid package | `Invalid package id.` |
| Org resolve fail | `Could not resolve organization.` |
| Empty barcode | `Barcode is required.` |
| Package missing | `Package not found for this organization.` |
| Org mismatch | `Package organization mismatch.` |
| Wrong store | `This package belongs to another store — select the correct store.` |
| Bad slip id | `Invalid slip line id.` / `Slip line does not belong to this package.` |
| No conditions | `Select at least one condition for this unit.` |
| Evidence required | `Add at least one evidence photo for the selected issue(s).` |
| Expiry / lot | `Expiration date is required for this item.` / `Batch / lot # is required for this item.` |
| No store | `Store is required to save item scans.` |
| insertReturn fail | `ins.error` or `Failed to save item scan.` |

### `updateOperatorIntakeBoxPackageAction` — error messages

| Condition | `message` |
|-----------|-----------|
| Nothing to patch | `Nothing to update.` |
| Duplicate slip | `formatDuplicatePackingSlipMessage(...)` + `duplicatePackingSlip` |
| Wrong store on package | `formatUnauthorizedPackageInStoreMessage(...)` |
| Pallet not found | `Pallet not found for this organization.` |
| PostgREST | raw `error.message` on package/slip/pallet steps |

**Safe fallback on slip replace failure:** package row may already be updated (step A commits before slip replace); UI should reload and show error toast.

---

## Store + session

| Action | Input | Output | DB |
|--------|-------|--------|-----|
| **`getOperatorStoreScopeForOrganization`** | `requestedOrganizationId?` | `{ ok: true, snapshot }` / `{ ok: false, error }` | R: stores, organization_settings |

---

## Pallet + box collaboration

| Action | Input | Output | DB |
|--------|-------|--------|-----|
| **`listOperatorPackagesForPalletAction`** | `requestedOrganizationId`, `palletId`, `storeId?` | `{ ok: true, packages[] }` | R: pallets, packages, profiles |
| **`fetchOperatorPalletHydrationAction`** | org, palletId, storeId? | `{ ok: true, row }` / wrongStore | R: pallets |
| **`findOperatorPalletByTrackingNumberAction`** | org, tracking, activeStoreId? | `{ ok: true, pallet \| null, wrongStore? }` | R: pallets (via helper) |
| **`createOperatorPalletAction`** | `CreateOperatorPalletActionInput` | `{ ok: true, id, pallet_number }` / dup | W: pallets |
| **`commitOperatorPalletShipmentStepAction`** | shipment fields + photo URLs | `{ ok: true, creatorDisplayLabel, ... }` | R/W: pallets |
| **`insertOperatorIntakeBoxPackageAction`** | palletId?, packageNumber, storeId?, tracking? | `{ ok: true, packageId, reusedExisting? }` | R/W: packages (via `insertIntakeBoxPackage`) |
| **`insertOperatorUnknownPackageAction`** | org, storeId, scannedCode | `{ ok: true, packageId }` | W: packages (placeholder) |

---

## item-actions.ts

| Action | Input | Output | DB |
|--------|-------|--------|-----|
| **`operatorReceiveItem`** | `OperatorReceiveItemInput` (EP hint, sku, fnsku, conditions, qty…) | `{ ok: true, insertedIds, expected_package_id }` | W: return_items; R/W: expected_packages |
| **`manualOverrideReturnItemProductResolution`** | `return_item_id`, `resolved_product_id`, actor | `{ ok: true }` | R: return_items, products; W: return_items linkage; W: return_audit_log |

### `operatorReceiveItem` — errors

| Condition | `error` |
|-----------|---------|
| EP not resolved | `Could not resolve expected_packages id.` / SKU required / multiple matches |
| Insert fail | rolls back inserted return_items |
| EP counter update fail | rolls back return_items |

**Neda:** Do **not** call for BOX slip item scan; use `insertOperatorPackageItemAction`.

---

## Shared downstream: `insertReturn`

Called by `insertOperatorPackageItemAction` and `operatorReceiveItem`.

| | |
|---|---|
| **W** | `return_items` |
| **R** | `packages` (pallet_id, order_id), store resolution |
| **Post** | `applyReturnItemProductEnrichmentAfterInsert` → optional linkage patch |

Payload fields used by operator item scan: `organization_id`, `store_id`, `package_id`, `marketplace: "amazon"`, `item_name`, `conditions`, `expiration_date`, `batch_number`, `photo_evidence`, `fnsku` or `sku`.

---

## Evidence storage

| Action | Module |
|--------|--------|
| **`deleteOperatorEvidenceStorageByPublicUrlsAction`** | `lib/scanner/operator-evidence-storage-delete.ts` |

Deletes objects in `media` / `manifests` buckets under `{orgId}/…` after UI removes URLs.

---

## Pure functions (import from `lib/scanner`, not actions)

| Name | File |
|------|------|
| `resolveItemBarcodeAgainstSlipRows` | `operator-slip-item-resolve.ts` |
| `resolveItemBarcodeAgainstExpectedRows` | `operator-item-resolve.ts` |
| `resolveOperatorBarcode` | `operator-resolve-barcode.ts` |
| `resolveProductForScannerItem` | `resolve-product-for-scanner-item.ts` |
| `filterPackageItemDiscrepancyTags` | `item-unit-discrepancy-tags.ts` |
