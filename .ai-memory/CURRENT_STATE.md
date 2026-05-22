# Neda branch — current state

**Last sync:** V195-NEDA-HANDOFF-FILE-SYNC-AND-USAGE (2026-05-21)  
**Active DB:** Staging `eiqfaapyumhixxoeltgu` (operator-mobile / returns server actions)

---

## Handoff docs on branch

| File | Status |
|------|--------|
| `NEDA_FINAL_BACKEND_HANDOFF_V193.md` | Present — consolidated 12 rules |
| `NEDA_BACKEND_PRODUCT_LINKAGE_HANDOFF_V178.md` | Present |
| `NEDA_EXPECTED_PACKAGES_INVENTORY_VIEWS_HANDOFF_V179.md` | Present |
| `.ai-memory/NEDA_HANDOFF.md` | Present |
| `.ai-memory/DATABASE_CONTRACT.md` | Present |
| `.ai-memory/PRODUCT_ID_MAPPING_STATUS.md` | Present |
| `.ai-memory/CURRENT_STATE.md` | Present (this file) |
| `.ai-memory/NEXT_ACTIONS.md` | Present |

---

## UI contract (implemented)

- Barcode input → server preview lookup (`previewOperatorItemBarcodeLinkageAction`, `buildOperatorBarcodeResolverFields`)
- Save/edit → `applyReturnItemProductEnrichment*` / `hydrateReturnItemProductLinkage` (resolver-on-save)
- Display → `ProductLinkageDisplayContract` via `OperatorProductLinkageMeta`, `ProductLinkagePrimaryLink`, `productLinkageFromReturnRecord`
- Product detail → `/scanner/operator-mobile/products/[productId]` with `?from=` back navigation
- EP expected/scanned → `mergeExpectedWithScannedCounts` (product_id-first)
- Package drawer child rows → same linkage contract + `stopPropagation` on product column

---

## Latest audits (PASS)

| Task | Run | Verdict |
|------|-----|---------|
| NEDA-23 auto lookup + detail links | `neda-23-auto-lookup-detail-link-and-views-v193/run-20260521-001` | PASS |
| V194 UI polish + lookup sync | `v194-neda-ui-polish-lookup-sync/run-20260521-001` | PASS (22/22) |
| V195 handoff file sync | `v195-neda-handoff-file-sync-and-usage/run-20260521-001` | See manifest |

---

## Forbidden pattern baseline (scanner + returns UI)

Stale scan target: **0** for `package_items`, `.from("returns")`, client `products.insert`, client `products.select`.

---

## DB topology reminder

| Ref | Role |
|-----|------|
| `eiqfaapyumhixxoeltgu` | Staging — use for Neda |
| `kxsvedvpjldygtdbylsy` | Original/current dev — not Neda active target |
| *(none)* | Future production — not created |
