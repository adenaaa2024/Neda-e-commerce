# Neda handoff — scanner backend contract (v165)

**Date:** 2026-05-18  
**Contract status:** **PASS**  
**Audit folder:** `.cursor/audit-reports/scanner-backend-contract-sync-v165/run-20260518-001/`

---

## What you are wiring

Operator-mobile **BOX workflow**: identify → pallet/box → slip lines → scan items into **`return_items`**.  
Do **not** use `package_items`. Do **not** create products from OCR.

---

## Files to import (server actions)

From `app/scanner/operator-mobile/_components/operator-store-actions.ts`:

| Priority | Function |
|----------|----------|
| **P0** | `listOperatorSlipContentsForPackageAction` |
| **P0** | `listOperatorPackageItemsForPackageAction` |
| **P0** | `insertOperatorPackageItemAction` |
| **P0** | `updateOperatorIntakeBoxPackageAction` / `saveOperatorSlipVisionAction` |
| **P1** | `listOperatorPackagesForPalletAction` |
| **P1** | `insertOperatorIntakeBoxPackageAction` |
| **P1** | `checkOperatorSlipCodeDuplicateAction` |
| **P1** | `getOperatorStoreScopeForOrganization` (via session provider) |
| **P2** | `fetchOperatorPalletHydrationAction`, `createOperatorPalletAction`, `commitOperatorPalletShipmentStepAction`, `findOperatorPalletByTrackingNumberAction` |

From `app/scanner/operator-mobile/item-actions.ts`:

| Priority | Function |
|----------|----------|
| **Avoid for BOX slip scan** | `operatorReceiveItem` (EP counter path) |
| **Optional** | `manualOverrideReturnItemProductResolution` (existing product pick) |

---

## Client helpers (same behavior as production scan page)

| Helper | Module |
|--------|--------|
| `resolveItemBarcodeAgainstSlipRows` | `lib/scanner/operator-slip-item-resolve.ts` |
| `resolveOperatorBarcode` | `lib/scanner/operator-resolve-barcode.ts` |
| `useScannerProductResolutionBadges` | `hooks/use-scanner-product-resolution.ts` |
| Discrepancy / expiry rules | `lib/scanner/item-unit-discrepancy-tags.ts` |

---

## Minimal save flow (copy this sequence)

1. User has `packageId` + `sessionStoreId` + workspace `orgId`.
2. Load slip: `listOperatorSlipContentsForPackageAction(orgId, packageId, storeId)`.
3. Scan barcode → `resolveItemBarcodeAgainstSlipRows(barcode, slipRows)`.
4. Open unit modal → on submit:

```ts
await insertOperatorPackageItemAction({
  requestedOrganizationId: orgId,
  packageId,
  storeId: sessionStoreId,
  slipContentId: singleMatch ? slip.id : null,
  scannedBarcode: barcode,
  matchKind: tier === "fnsku" ? "fnsku" : tier === "upc" ? "upc" : "unexpected",
  quantity: 1,
  discrepancyTags: payload.discrepancyTags,
  expiryDate: payload.expiryDate,
  lotNumber: payload.lotNumber,
  evidenceUrls: payload.evidenceUrls,
  traceabilityRequired: payload.traceabilityRequired,
});
```

5. On success, increment local nonce and call `listOperatorPackageItemsForPackageAction` again.

---

## Minimal hydrate flow

```ts
const res = await listOperatorPackageItemsForPackageAction(orgId, packageId, storeId);
if (res.ok) setUnits(res.rows);
```

Each row: `id`, `slip_content_id`, `scanned_barcode`, `match_kind`, `discrepancy_tags`, `expiry_date`, `lot_number`, `evidence_urls`.

---

## Reference implementation

`app/scanner/operator-mobile/scan/page.tsx` — search:

- `insertOperatorPackageItemAction` (~line 5232)
- `listOperatorPackageItemsForPackageAction` (~line 3448)
- `listOperatorSlipContentsForPackageAction` (~line 3410)
- `handleItemBarcodeScan` (~line 5264)

---

## Test fixture (original DB)

| Field | Value |
|-------|-------|
| Package id | `9528d923-3d27-4aed-a773-095b5028743d` |
| Slip lines | 2 |
| return_items | 3 (includes NEDA-06 smoke row) |
| Sample FNSKU | `X004N9OS4J` |

---

## Blockers

**None** for core contract. See `blockers.md` for staging and EP-path notes.

---

## Related docs in this folder

| File | Contents |
|------|----------|
| `backend-contract.md` | Full shapes and auth |
| `action-map.md` | All actions + errors |
| `db-read-write-map.md` | Tables by journey |
| `ui-integration-map.md` | UI phase → API |
| `forbidden-old-contracts.md` | No-go list |
| `staging-test-plan-after-clone.md` | After ENV-06 |

---

## Prior audits (PASS)

- `scanner-neda-06-small-write-smoke/run-20260518-001`
- `scanner-neda-08-final-ui-signoff/run-20260518-001`
- `scanner-neda-09-browser-spot-check/run-20260518-001`
