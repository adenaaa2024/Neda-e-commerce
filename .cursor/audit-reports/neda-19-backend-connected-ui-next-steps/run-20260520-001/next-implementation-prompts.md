# Next implementation prompts — NEDA-19

Copy-paste prompts for Neda agent runs. Staging only; no migrations; no resolver changes.

---

## PROMPT-1 (recommended next — S1 Item clarity)

```
NEDA-19-S1: Operator-mobile item scan clarity (UI-only + existing hydrate actions)

Context:
- NEDA-18 PASS: return_items linkage shows on Expected Items (PKG-MNI9DR05 / SAM).
- Do NOT change resolver logic, migrations, package_items, or returns table.
- Saves stay on insertOperatorPackageItemAction only.

Files: app/scanner/operator-mobile/scan/page.tsx, ItemUnitRecordModal.tsx (UI-6 only if needed)

Tasks:
1. UI-H1: Add subtitle "Item scan" under Expected Items header; keep stepper Item label.
2. UI-1: Show visible Awaiting chip on slip cards (not dot-only).
3. UI-3: Show "Updating counts…" while listOperatorPackageItemsForPackageAction hydration runs.
4. UI-4: Skeleton rows while listOperatorSlipContentsForPackageAction loads.
5. UI-H2: Show "{scanned} scanned / {expected} expected" in header from packageItemScanState + slip qty.
6. UI-C1: When itemInspectionSlipCells.length === 0 but listOperatorPackageItemsForPackageAction has rows,
   render per-unit rows with productLinkagePrimaryLabel + OperatorProductLinkageMeta (unexpected package path).

Verify:
  npx tsx scripts/neda-18-item-scan-return-linkage-browser-proof.ts
  npm run build

Hard constraints: staging ref eiqfaapyumhixxoeltgu; no browser supabase insert/update on scan page.
```

---

## PROMPT-2 (S2 Contract hygiene)

```
NEDA-19-S2: Remove browser pallet insert + client products query on scan page

Tasks:
1. UI-C3: In ensureShipmentReceivingPallet, replace supabase.from("pallets").insert with createOperatorPalletAction only.
2. UI-C4: In populateDraftFromEpRow, remove supabase.from("products").select; use EP line product_linkage for catalogName hints.

Verify:
  npx tsx scripts/neda-final-runtime-replay-after-v189.ts
  (expect browser_direct_writes_on_scan_page = 0)

No migrations. No resolver changes.
```

---

## PROMPT-3 (S3 Expected vs scanned + drawer)

```
NEDA-19-S3: Expected/scanned parity + package drawer refresh

Tasks:
1. UI-H3: For UNEXPECTED tracking (0 expectedPkgLines expected qty), set scannedQty on shipment table from return_items aggregate.
2. UI-C2: After successful box save, increment packageItemsHydrationNonce before closing intake UI.
3. UI-H8: ExpectedInventoryLineRow — use OperatorProductLinkageMeta only; remove duplicate resolution badges.
4. UI-H5: Saved-box picker shows package_code + top linkage label when slip rows exist.

Verify:
  npx tsx scripts/expected-inventory-neda-read-model-signoff-v181.ts
  npx tsx scripts/neda-final-runtime-replay-after-v189.ts
```

---

## PROMPT-4 (blocked — after BLK-1)

```
NEDA-19-S4: Operator manual product link sheet (requires searchOperatorProductsForStoreAction)

Prerequisite: engineering adds read-only searchOperatorProductsForStoreAction(orgId, storeId, query).

UI:
- Tap OperatorProductLinkageMeta chip on slip or hydrate row → bottom sheet.
- Search input debounced → list products → confirm calls manualOverrideReturnItemProductResolution.
- On success, bump packageItemsHydrationNonce + slip refresh.

Do NOT products.insert. Do NOT change buildProductLinkageDisplayContract resolver inputs.

Verify with staging write approval: scripts/next-scanner-04-staging-e2e.ts (if approved).
```

---

## PROMPT-5 (pallet UX copy — optional)

```
NEDA-19-S5: Pallet + unknown-flow copy polish (UI-7, UI-8, UI-9, UI-12 only)

No new API. Staging browser smoke on identify gate + unknown modal.
```

---

## Audit artifact update (after each prompt)

Write or append to:
`.cursor/audit-reports/neda-19-backend-connected-ui-next-steps/<run_id>/implementation-log.md`

Include: prompt id, files touched, verification command results, blockers hit.
