# Safe UI-only tasks — NEDA-19

**Definition:** Changes limited to `app/scanner/operator-mobile/**` and shared display helpers. No migrations, no resolver edits, no new tables, no browser writes to `return_items` / `pallets` / `packages`.

Approved from prior audit `scanner-operator-flow-review-v163` plus NEDA-19 additions.

---

## P0 — Do first (biggest operator clarity)

| ID | Change | File(s) |
|----|--------|---------|
| **UI-1** | Visible **Awaiting** label on slip cards (match IN PROGRESS / RECEIVED chip style) | `scan/page.tsx` — `itemInspectionSlipLinePresentation` / `slipCardStatusMark` |
| **UI-3** | **Updating counts…** under Expected Items while package-item hydration in flight | `scan/page.tsx` — track promise from `listOperatorPackageItemsForPackageAction` effect |
| **UI-H1** | Harmonize **Item scan** copy: stepper + panel title/subtitle (audit expects both semantics) | `scan/page.tsx` — items phase header ~L10633 |
| **UI-H2** | Header chip: `{hydratedActive} scanned` / `{slipExpected} expected` from existing hydrate state | `scan/page.tsx` — items phase header |

---

## P1 — Feedback and errors

| ID | Change | File(s) |
|----|--------|---------|
| **UI-4** | 2–3 skeleton rows while slip lines load | `scan/page.tsx` — slip fetch effect ~L3587 |
| **UI-5** | Sticky toast for `itemBarcodeMiss` / `itemReceiveError` | `scan/page.tsx` — mirror `intakeToast` |
| **UI-6** | Pass overscan warning into `ItemUnitRecordModal` | `scan/page.tsx`, `ItemUnitRecordModal.tsx` |
| **UI-12** | **Processing scan…** on scan frame when `busy` (gate + box + items) | `scan/page.tsx` |
| **UI-H8** | On `ExpectedInventoryLineRow`, drop duplicate `useScannerProductResolutionBadges` when `OperatorProductLinkageMeta` present | `scan/page.tsx` ~L1910 |

---

## P2 — Training / unknown-flow copy

| ID | Change | File(s) |
|----|--------|---------|
| **UI-7** | Compact **?** help on item phase (unexpected vs Add/Scan) | `scan/page.tsx` |
| **UI-8** | Unknown modal: emphasize Tracking + Box | `scan/page.tsx` — `unknownModal` |
| **UI-9** | Rename ambiguous CTAs (new box vs off-slip unit) | `scan/page.tsx` |
| **UI-10** | Show **Scanner ready** / last code under laser in items phase | `scan/page.tsx` |
| **UI-2** | Bottom nav Alerts badge: hide or `alertCount={0}` until wired | `ScannerBottomNav.tsx` |
| **UI-13** | **Today** chip beside expiry in modal | `ItemUnitRecordModal.tsx` |

---

## P2 — Client-only throughput

| ID | Change | File(s) |
|----|--------|---------|
| **UI-11** | Queue wedge scans while modal/busy; process after save | `scan/page.tsx` — `handleItemBarcodeScan` |

---

## P2 — Package drawer / EP table (presentation)

| ID | Change | File(s) |
|----|--------|---------|
| **UI-H4** | No code required for signoff—re-run browser proof after S1 | Audit only |
| **UI-H5** | Picker subtitle: package code + top linkage label when known | `scan/page.tsx` — saved box list |

---

## Explicitly NOT UI-only (track separately)

| ID | Why |
|----|-----|
| UI-C1 | Uses `listOperatorPackageItemsForPackageAction` row mapping—logic/UI |
| UI-C3 | Replace `pallets.insert` with server action |
| UI-C4 | Remove `products` client select |
| Manual review sheet | Needs product search action (BLK-1) |

---

## Acceptance (UI-only PR)

- `npm run build` / `tsc --noEmit` pass
- `neda-18-item-scan-return-linkage-browser-proof.ts` PASS
- No new `package_items` or `.from("returns")` refs
- Staging hosts only (`eiqfaapyumhixxoeltgu`)
