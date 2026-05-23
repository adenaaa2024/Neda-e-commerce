# NEDA-19 — Backend-connected UI next steps

**Run:** `run-20260520-001`  
**Status:** Ready for Neda implementation (staging only)  
**Baseline:** NEDA-18 PASS · final runtime replay v189 PASS · `ProductLinkageDisplayContract` canonical

---

## Executive summary

Core read/write wiring for operator-mobile is **already on staging**: expected packages, inventory gate, slip/package hydrate, `return_items` inserts, and `OperatorProductLinkageMeta` badges. NEDA-19 defines **polish and gap-fill** work that stays inside approved server actions—no resolver changes, no migrations, no `package_items` / `returns` table.

Priority order:

1. **Item / expected-vs-scanned clarity** (slip cards, hydration feedback, unexpected-package rows)
2. **Package drawer runtime parity** (status chip + linkage on picker rows—static PASS, deepen live proof)
3. **Pallet flow hardening** (remove remaining browser `pallets.insert`; keep `createOperatorPalletAction`)
4. **Linkage UX** (unmapped vs resolved-without-catalog copy; ambiguous badge when data exists)
5. **Manual review entry** (blocked until operator product-search read exists—see `blocked-tasks.md`)

---

## 1. Scanner item scan screen (`flowPhase === "items"`)

| ID | Task | Priority | Type |
|----|------|----------|------|
| UI-H1 | Align phase chrome: stepper says **Item**, panel title **Expected Items**—add subtitle *Item scan* or harmonize copy so audits and operators see one label | P0 | UI-only |
| UI-1 | Show **Awaiting** chip on slip cards (not dot-only) via `itemInspectionSlipLinePresentation` | P0 | UI-only |
| UI-3 | **Updating counts…** under Expected Items header while `listOperatorPackageItemsForPackageAction` hydration runs (`packageItemsHydrationNonce`) | P0 | UI-only |
| UI-4 | Skeleton rows while `listOperatorSlipContentsForPackageAction` loads (`itemInspectionSlipLines`) | P1 | UI-only |
| UI-6 | Surface `itemOverscanWarning` in `ItemUnitRecordModal` subtitle/banner | P1 | UI-only |
| UI-5 | Sticky bottom toast for `itemBarcodeMiss` / `itemReceiveError` (match intake toast) | P1 | UI-only |
| UI-11 | Client scan queue: hold wedge input while `busy`, flush after `insertOperatorPackageItemAction` | P2 | UI-only |
| UI-C1 | **Unexpected-only packages** (0 slip lines, scanned `return_items`): show per-unit rows from `listOperatorPackageItemsForPackageAction` with `product_linkage` + qty—not only aggregated FNSKU lines in tracking table | P0 | UI + existing action |
| UI-H2 | Package header hint: `{activeCount} items` / `{n} scanned` from hydration (NEDA-18 `hydrated_count_hint` was n/a) | P1 | UI + existing action |

**Verified today (do not re-wire):**

- Save path: `insertOperatorPackageItemAction` → `return_items`
- Slip linkage: `listOperatorSlipContentsForPackageAction` → `product_linkage`
- Modal: `ItemUnitRecordModal` + `OperatorProductLinkageMeta`
- Hydrate: `listOperatorPackageItemsForPackageAction` → `aggregateOperatorPackageItemRows`

**Fixture:** `PKG-MNI9DR05` (SAM) — 2 active `return_items`, labels `No product link yet` + FNSKU tokens in DOM (NEDA-18).

---

## 2. Expected vs scanned panel

Two surfaces share Exp/Scan/Var semantics; keep them consistent.

| Surface | Location | Contract | Next work |
|---------|----------|----------|-----------|
| **Tracking shipment table** | Identify / in-progress tracking (`expectedPkgLines`, `ExpectedInventoryLineRow`) | `loadTrackingExpectationSnapshot`, `fetchReturnItemsScannedBySkuFnsku*` | UI-H3: when tracking is UNEXPECTED (0 EP), prefer scanned counts from `return_items` aggregate so Scn column matches hydration |
| **Shipment lines (reference)** | Box intake table `#expected-intake-table` | Same snapshot + `formatScanVarianceLabel` | UI-only: sticky header, scroll affordance (already has View all) |
| **Item phase slip list** | Expected Items cards | Slip qty + `packageItemScanState` | UI-1, UI-3, UI-4 |
| **Shipment summary** (nested under Expected Items) | `expectedPkgLines.slice(0, 8)` | EP read contract | UI-only: expand/collapse when >8 lines |

**Policy (unchanged):** Scanned counts from **`return_items`** helpers—not `v_scanned_items_counted`. Inventory view reads `v_inventory_item_status` for identify gate only.

---

## 3. Package drawer (active box + saved-box picker)

| ID | Task | Priority | Type |
|----|------|----------|------|
| UI-H4 | Runtime proof: open saved box → single `boxScanResolvedPkgBadge` + picker badge + slip row `OperatorProductLinkageMeta` (v181 static PASS) | P1 | UI-only + replay script |
| UI-H5 | Picker row: show `productLinkagePrimaryLabel` on first line when package has slip lines (read already on slip list after select) | P2 | UI-only |
| UI-C2 | After box save, bump `packageItemsHydrationNonce` before closing drawer so Exp/Scn on intake table refresh | P1 | UI-only (wiring) |

**Contract:** `listOperatorSlipContentsForPackageAction`, `updateOperatorIntakeBoxPackageAction`, `listOperatorPackagesForPalletAction` (picker).

---

## 4. Pallet flow

| ID | Task | Priority | Type |
|----|------|----------|------|
| UI-C3 | Replace client `supabase.from("pallets").insert` in `ensureShipmentReceivingPallet` with `createOperatorPalletAction` only (v189 flagged 1 browser write) | P0 | UI + existing action |
| UI-12 | Gate/box **Processing scan…** on scan frame when `busy` | P1 | UI-only |
| UI-8 | Unknown modal: emphasize Tracking + Box; demote Item/Pallet | P2 | UI-only |
| UI-9 | Rename **Start new shipment (box)** vs **Record off-slip unit** | P2 | UI-only |
| — | Pallet photos / BOL arrays | — | Already via `fetchOperatorPalletHydrationAction` + `pallets.*_urls`; no new API |

**Identify gate:** `fetchVInventoryStatusForScanCode`, `fetchExpectedPackagesForTracking`, `createOperatorPalletAction` / `findOperatorPalletByTrackingNumberAction`—do not write `return_items` at gate.

---

## 5. Unresolved / ambiguous product badges

| State | Label | Component | Next work |
|-------|-------|-----------|-----------|
| Unresolved / no catalog name | No product link yet | `OperatorProductLinkageMeta` | UI-H6: when `identifier_resolution_status === "resolved"` but `product_name` empty, show **Linked — name pending** (display helper only—no resolver change) |
| Ambiguous | Needs review | `OperatorProductLinkageMeta` | UI-H7: add staging-safe demo row or wait for ambiguous fixture; verify chip + tooltip |
| EP rows | SKU · title fallback | `buildExpectedPackageProductLinkage` | No EP `identifier_resolution_*` select on staging (42703 fallback)—keep enriched display path |

Remove duplicate badges: `ExpectedInventoryLineRow` uses both `OperatorProductLinkageMeta` and `useScannerProductResolutionBadges`—**UI-H8**: prefer meta component only on EP lines to avoid double chips.

---

## 6. Manual review entry points

| Entry | Today | Target |
|-------|-------|--------|
| Returns admin drawer | `manualOverrideReturnItemProductResolution` wired | Out of scope for operator-mobile |
| Operator item row | None | Tap **Needs review** / **No product link yet** → sheet with product search → override action |
| Item modal | Linkage read-only | Optional **Link product** CTA |

**Blocked** until `BLK-1` (operator product search read). Override write action **exists** (`item-actions.ts`); picker does not.

---

## Suggested sprint slices

| Slice | Tasks | Verification |
|-------|-------|----------------|
| **S1 — Item clarity** | UI-1, UI-3, UI-4, UI-H1, UI-H2, UI-C1 | `npx tsx scripts/neda-18-item-scan-return-linkage-browser-proof.ts` |
| **S2 — Contract hygiene** | UI-C3, remove `products` client select in `populateDraftFromEpRow` | `neda-final-runtime-replay-after-v189.ts` (browser_writes → 0) |
| **S3 — Drawer + EP table** | UI-H4, UI-C2, UI-H3, UI-H8 | `expected-inventory-neda-read-model-signoff-v181.ts` |
| **S4 — Manual review** | After BLK-1 | `next-scanner-04` override smoke (staging write approval) |

---

## Out of scope (hard constraints)

- Production DB, migrations, DDL
- `package_items`, `.from("returns")`, `products.insert`
- Resolver / `resolveOperatorBarcode` logic changes
- Amazon SP-API, OpenAI/OCR new integrations
- Changing `buildProductLinkageDisplayContract` resolution rules (display copy helpers OK)
