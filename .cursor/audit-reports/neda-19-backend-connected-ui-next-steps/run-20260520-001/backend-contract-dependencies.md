# Backend contract dependencies — NEDA-19

Maps each UI task to **approved** server/read paths. Neda must not add client `supabase.from(...).insert/update` on the scan page except where explicitly being removed (UI-C3).

---

## Contract libraries (source of truth)

| Concern | Module | Key exports |
|---------|--------|-------------|
| Linkage display | `lib/scanner/product-linkage-display-contract.ts` | `ProductLinkageDisplayContract`, `buildProductLinkageDisplayContract`, `productLinkagePrimaryLabel`, labels |
| EP display | `lib/scanner/expected-packages-read-contract.ts` | `buildExpectedPackageProductLinkage`, `formatScanVarianceLabel`, `mergeExpectedPackageRowsProductLinkage` |
| Tracking / EP fetch | `lib/scanner/operator-tracking-expectations.ts` | `loadTrackingExpectationSnapshot`, `fetchExpectedPackagesForTracking`, `fetchReturnItemsScannedBySkuFnsku*` |
| Inventory gate | `lib/scanner/v-inventory-status.ts` | `fetchVInventoryStatusForScanCode`, `resolveInventoryGateVisualStatus` |
| UI meta | `app/scanner/operator-mobile/_components/OperatorProductLinkageMeta.tsx` | Chips only—no fetch |

---

## Server actions (`operator-store-actions.ts`)

| Action | Used by | UI tasks depending on it |
|--------|---------|---------------------------|
| `listOperatorSlipContentsForPackageAction` | Slip list, picker, item inspection | UI-4, UI-H4, UI-H5, package drawer lines |
| `listOperatorPackageItemsForPackageAction` | Item hydrate, linkage per unit | UI-3, UI-C1, UI-H2, UI-H6 (read) |
| `insertOperatorPackageItemAction` | `ItemUnitRecordModal` save | UI-11 (after save refresh) |
| `updateOperatorIntakeBoxPackageAction` | Box intake save | UI-C2, mismatch banners |
| `listOperatorPackagesForPalletAction` | Saved-box picker | UI-H4 |
| `createOperatorPalletAction` | Pallet create (partial) | **UI-C3** (must replace client insert) |
| `findOperatorPalletByTrackingNumberAction` | Cross-store gate | Pallet flow |
| `fetchOperatorPalletHydrationAction` | Pallet docs / order context | Pallet flow (read) |
| `commitOperatorPalletShipmentStepAction` | Pallet shipment commit | Pallet flow (write—existing) |
| `saveOperatorSlipVisionAction` | Slip OCR persist | Box intake (no new contract) |

**Linkage build inside actions:** `fetchProductNamesByResolvedIds` + `buildProductLinkageDisplayContract` on `return_items` / `slip_contents` rows (`RETURN_SCANNER_LINKAGE_SELECT`).

---

## Client reads still on scan page (to remove or replace)

| Call site | Table | Task |
|-----------|-------|------|
| `ensureShipmentReceivingPallet` ~L5956 | `pallets.insert` | **UI-C3** → `createOperatorPalletAction` |
| `populateDraftFromEpRow` ~L5134 | `products.select("*")` by barcode | **UI-C4** → server lookup action or drop catalog enrichment (use EP `product_linkage` only) |
| `profiles.select` | `profiles` | OK (display name); not inventory |

---

## Manual review write (exists; read gap)

| Action | File | Status |
|--------|------|--------|
| `manualOverrideReturnItemProductResolution` | `app/scanner/operator-mobile/item-actions.ts` | **Implemented** — patches `return_items`, audits `return_audit_log` |
| Operator product search/list | — | **Missing** — returns UI uses admin catalog search; not exposed to operator-mobile |

**Dependency chain for manual review UI:**

1. New read: `searchOperatorProductsForStoreAction(orgId, storeId, query)` → `{ id, product_name, sku, fnsku }[]` (limit 20, org+store scoped)
2. Existing write: `manualOverrideReturnItemProductResolution({ return_item_id, resolved_product_id, actor })`
3. UI: sheet from `OperatorProductLinkageMeta` chip tap on slip or hydrate row

Do **not** call override from browser Supabase.

---

## EP / inventory staging notes

| Capability | Staging | UI impact |
|------------|---------|-----------|
| `expected_packages.identifier_resolution_*` | Absent (intentional) | Use `buildExpectedPackageProductLinkage` + SKU/FNSKU fallback |
| `return_items` linkage columns | Present | Full meta on item/slip surfaces |
| `v_inventory_item_status` | Present | Identify gate lines |
| Migration `20260717120000` | Not applied by Neda | No client EP resolution SELECT |

---

## Verification scripts (after each slice)

```bash
npx tsx scripts/neda-18-item-scan-return-linkage-browser-proof.ts
npx tsx scripts/neda-final-runtime-replay-after-v189.ts
npx tsx scripts/scanner-neda-17-expected-packages-inventory-views.ts
npx tsx scripts/expected-inventory-neda-read-model-signoff-v181.ts
```

Optional regression: `scripts/scanner-neda-16-backend-product-linkage-handoff.ts`

---

## Task → contract matrix

| Task ID | Needs new backend? | Contracts / actions |
|---------|-------------------|---------------------|
| UI-1 – UI-12, UI-H1, UI-H2, UI-H4–H8 | No | Existing actions + presentation |
| UI-C1 | No | `listOperatorPackageItemsForPackageAction` |
| UI-C2 | No | Hydration nonce + existing actions |
| UI-C3 | No | `createOperatorPalletAction` |
| UI-C4 | **Optional small read** | Product barcode lookup server action, or remove client query |
| Manual review UI | **Yes (read)** | `searchOperatorProductsForStoreAction` + existing override |
| UI-D1 (deferred) | Additive select only | `product_match_status` on package items list |
