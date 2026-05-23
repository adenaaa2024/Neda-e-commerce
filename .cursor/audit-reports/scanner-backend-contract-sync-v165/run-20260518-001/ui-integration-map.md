# UI integration map — Neda ↔ backend

**Reference UI:** `app/scanner/operator-mobile/scan/page.tsx` (production wiring)  
**Routes:** `/scanner/operator-mobile` (hub), `/scanner/operator-mobile/scan` (workflow)

Neda should preserve **layout/markup** from reference; swap only data wiring to the actions below.

---

## Session prerequisites

| UI state | Backend |
|----------|---------|
| Store picker | `getOperatorStoreScopeForOrganization` via `OperatorSessionStoreProvider` |
| `orgId` / workspace org | `requestedOrganizationId` on every server action |
| `sessionStoreId` | `storeId` on package/slip/item actions |

---

## 1. Identify gate

| UI | Phase state | Backend / client |
|----|-------------|------------------|
| Tracking scan input | `identifyGatePhase`: `idle` → `loading` → `matched` \| `unmatched` | `fetchExpectedPackagesForTracking`, `fetchVInventoryStatusForScanCode`, `resolveOperatorBarcode(..., { only: "tracking" })` |
| Status pill | `identifyGateInventoryVisual` | `resolveInventoryGateVisualStatus` |
| Wrong store banner | `OperatorCrossStoreScopeBanner` | `findOperatorPalletByTrackingNumberAction` → `wrongStore` |
| Physical box count | `identifyGatePhysicalBoxStr` | client state |
| Pallet ensure | — | `createOperatorPalletAction` / client pallet insert |
| Unknown tracking modal | `unknownModal` | **Client-only** session advance (`handleCreateUnknownPackage`) — does not call `insertOperatorUnknownPackageAction` today |
| Product hint (item kind) | — | `resolveOperatorBarcode` `only: "item"` → `products` / `product_identifier_map` **read only** |

**Safe fallback:** No EP match → stay `unmatched`, allow manual pallet/box path; do not write `return_items` at gate.

**Fixture note:** Arbitrary tracking (e.g. `123`) may not match EP — not a wiring bug.

---

## 2. Slip list (packing slip lines)

| UI | Backend |
|----|---------|
| Box selected / `itemScanPackageId` | `listOperatorSlipContentsForPackageAction(orgId, packageId, storeId)` |
| Row mapping | `mapSlipContentRowToVisionLine` (client) |
| Missing line flag | `slip_contents.notes` JSON `{ "missing": true }` |
| Order mismatch banner | `conflicting_order_id` vs `order_id` on rows + `palletMixedOrderIds` from save |
| Product badges on line | `identifier_resolution_*` when present in select; `useScannerProductResolutionBadges` |

**Reload trigger:** package id change, after `saveOperatorSlipVisionAction` success, `packageItemsHydrationNonce` sibling effects.

**Safe fallback:** Empty `rows` → show empty slip table; allow manual line entry if product supports it.

---

## 3. Item scan / save

| UI | Backend |
|----|---------|
| Barcode input (`handleItemBarcodeScan`) | `resolveItemBarcodeAgainstSlipRows` (client) |
| Single match | Open `ItemUnitRecordModal` with `slipContentId` |
| Ambiguous | `slipLineCandidatePicker` state |
| None / unexpected | `unexpectedPackageItemModal` → save with `matchKind: "unexpected"` |
| Modal save | **`insertOperatorPackageItemAction`** |
| Demo / no Supabase | local counters only (`!isSupabaseConfigured()`) |

**Modal payload → action:**

| Modal field | Action field |
|-------------|--------------|
| discrepancy tags | `discrepancyTags` |
| expiry | `expiryDate` (`YYYY-MM-DD`) |
| lot | `lotNumber` |
| photos | `evidenceUrls` |
| perishable | `traceabilityRequired` |

**After success:** bump `packageItemsHydrationNonce`, `itemReceiveCountSyncNonce`, close modal, refocus scanner.

**Alternate path (not slip BOX):** `operatorReceiveItem` when receiving against **expected_packages** rows — different screen region / EP draft; do not merge with slip scan save.

---

## 4. Mismatch state (order / slip vs pallet)

| UI signal | Source |
|-----------|--------|
| Pallet vs slip order banner | `updateOperatorIntakeBoxPackageAction` → `palletMixedOrderIds: true` |
| Per-line conflict | `slip_contents.conflicting_order_id` populated on slip replace |
| Slip token | `slip_contents.order_id` |

**Safe fallback:** Show warning; allow operator to continue scanning items — items still save to `return_items`.

---

## 5. Unknown barcode

| Case | UI | Save |
|------|-----|------|
| No slip match | Unexpected modal | `insertOperatorPackageItemAction` with `matchKind: "unexpected"`, `slipContentId: null` |
| Resolve kind unknown at gate | Unknown modal | session-only or EP flow |

Hydrate shows `slip_content_id: null`, `match_kind: "unexpected"`.

---

## 6. Expiry capture

| UI | Validation |
|----|------------|
| `ItemUnitRecordModal` | `packageItemRequiresExpiryBlock` / tags include `expired` |
| Server | `insertOperatorPackageItemAction` requires `expiryDate` + `lotNumber` when `traceabilityRequired` or expired tag |

Stored on `return_items.expiration_date`, `return_items.batch_number`.

---

## 7. Reload hydration

| UI | Backend |
|----|---------|
| Scanned units list | `listOperatorPackageItemsForPackageAction` |
| Count vs slip expected | client compares slip `quantity` vs units per `slip_content_id` |
| Refresh nonce | `packageItemsHydrationNonce` |

**Row display:** `scanned_barcode`, `discrepancy_tags`, `expiry_date`, `lot_number`, `evidence_urls` from `photo_evidence` gallery helper.

**Safe fallback:** Action error → keep last good list + toast; empty list is valid for new box.

---

## 8. Pallet / box chrome (same page)

| UI step | Actions |
|---------|---------|
| Package picker | `listOperatorPackagesForPalletAction` |
| Pallet hydrate | `fetchOperatorPalletHydrationAction` |
| New box scan | `insertOperatorIntakeBoxPackageAction` |
| Box save | `updateOperatorIntakeBoxPackageAction` |
| Slip vision persist | `saveOperatorSlipVisionAction` |
| Dup slip | `checkOperatorSlipCodeDuplicateAction` |
| Shipment Save & Start | `commitOperatorPalletShipmentStepAction` |

---

## 9. Components map

| Component | Role |
|-----------|------|
| `OperatorSessionStoreProvider` | store scope |
| `ItemUnitRecordModal` | unit save payload |
| `OperatorDuplicatePackingSlipBanner` | dup slip message |
| `OperatorCrossStoreScopeBanner` | wrong store |
| `ScannerBottomNav` | nav only |

---

## Client Supabase vs server actions

| Use server actions | Use client `supabase` |
|--------------------|------------------------|
| slip list, item list, item insert, box save | identify gate EP reads, `resolveOperatorBarcode`, inventory views, pallet search in gate |

Reason: workspace org switch + RLS — server actions use service role with explicit org checks.
