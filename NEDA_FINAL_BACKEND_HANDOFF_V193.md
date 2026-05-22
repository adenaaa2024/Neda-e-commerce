# NEDA final backend handoff (V193)

**Owner:** Neda  
**Consolidates:** V178 linkage, V179 EP/inventory reads, NEDA-20/21 resolver consume, NEDA-23 detail links, V194 lookup polish  
**Mode:** Docs + UI consume — **no** migrations, production writes, Amazon SP-API calls, or OpenAI from verification scripts

---

## Twelve rules (current)

| # | Rule | Implementation |
|---|------|----------------|
| 1 | Product code input uses **backend lookup** | `previewOperatorItemBarcodeLinkageAction`, `buildOperatorBarcodeResolverFields`, blur/paste/scan handlers in wizard + drawer |
| 2 | Save/edit uses **server resolver-on-save** | `applyReturnItemProductEnrichmentAfterInsert/Update` in `app/returns/actions.ts`; `insertOperatorPackageItemAction` → `insertReturn` + `hydrateReturnItemProductLinkage` |
| 3 | Read/detail uses **ProductLinkageDisplayContract** | `lib/scanner/product-linkage-display-contract.ts`, `OperatorProductLinkageMeta`, `productLinkageFromReturnRecord` |
| 4 | Product link opens **exact product detail page** | `buildOperatorProductDetailHref` → `/scanner/operator-mobile/products/[productId]?from=…` |
| 5 | **Row click** opens row/detail, not product | Table `onClick` on `<tr>`; product column `stopPropagation` + `ProductLinkagePrimaryLink` |
| 6 | Package/pallet child items use **same contract** | Package drawer items table: `productLinkageFromReturnRecord` + `ProductLinkagePrimaryLink` |
| 7 | Expected/scanned uses **product_id-first** read model | `mergeExpectedWithScannedCounts` / `scannedByProductId` in `operator-tracking-expectations.ts` |
| 8 | **No direct browser DB writes** | Scanner/returns UI → server actions only; no `supabaseBrowser.from(...).insert` on scan surfaces |
| 9 | **No `package_items`** | Persistence via `return_items` / `RETURN_ITEMS_TABLE` |
| 10 | **No old `returns` table** | Use `return_items`; forbidden `.from("returns")` |
| 11 | **No browser Amazon API** | No `fetchProductFromAmazon` in returns wizard; SP-API mock UI gated `NODE_ENV === "development"` only |
| 12 | **No fake SP-API data** in prod paths | Dev mock block only; resolver uses catalog DB |

---

## Required repo artifacts

| Path | Role |
|------|------|
| `NEDA_FINAL_BACKEND_HANDOFF_V193.md` | This file — single rules index |
| `NEDA_BACKEND_PRODUCT_LINKAGE_HANDOFF_V178.md` | Slip/hydrate linkage detail |
| `NEDA_EXPECTED_PACKAGES_INVENTORY_VIEWS_HANDOFF_V179.md` | EP + inventory views |
| `.ai-memory/NEDA_HANDOFF.md` | Index + script map |
| `.ai-memory/DATABASE_CONTRACT.md` | Table/read/write map |
| `.ai-memory/PRODUCT_ID_MAPPING_STATUS.md` | Linkage column status |
| `.ai-memory/CURRENT_STATE.md` | Branch snapshot |
| `.ai-memory/NEXT_ACTIONS.md` | Safe next tasks |

---

## Canonical libraries

| Module | Purpose |
|--------|---------|
| `lib/scanner/product-linkage-display-contract.ts` | Display contract + labels |
| `lib/scanner/return-record-product-linkage.ts` | `productLinkageFromReturnRecord` |
| `lib/scanner/operator-product-detail-path.ts` | Detail href + back links |
| `lib/scanner/resolve-product-for-scanner-item.ts` | Server resolver |
| `lib/scanner/operator-barcode-preview-input.ts` | ASIN/FNSKU/UPC/SKU field split |
| `lib/scanner/operator-tracking-expectations.ts` | EP fetch + scanned merge |
| `lib/scanner/expected-packages-read-contract.ts` | EP variance/linkage helpers |
| `lib/scanner/v-inventory-status.ts` | Inventory view reads |

---

## UI components & actions

| Surface | Symbols |
|---------|---------|
| Primary product link | `ProductLinkagePrimaryLink` |
| Meta / badges | `OperatorProductLinkageMeta` (`linkResolvedProductId={false}` when primary link present) |
| Product detail page | `app/scanner/operator-mobile/products/[productId]/page.tsx` |
| Store actions | `operator-store-actions.ts`: `previewOperatorItemBarcodeLinkageAction`, `fetchOperatorProductDetailAction`, `insertOperatorPackageItemAction` |
| Returns save | `app/returns/actions.ts`: enrichment after insert/update |

---

## Database topology (Neda scope)

| Environment | Supabase project ref | Neda use |
|-------------|---------------------|----------|
| **Staging** (active) | `eiqfaapyumhixxoeltgu` | All operator-mobile verification |
| **Original / current dev** | `kxsvedvpjldygtdbylsy` | Legacy audits only — do not point Neda `.env.local` here |
| **Future production** | *(not created)* | Out of scope |

---

## Verification scripts

```bash
npx tsx scripts/neda-handoff-file-sync-and-usage-v195.ts
npx tsx scripts/v194-neda-ui-polish-lookup-sync.ts
npx tsx scripts/neda-23-auto-lookup-detail-link-and-views-v193.ts
npx tsx scripts/neda-21-product-resolution-contract-enforce-all-ui-v192.ts
```

Report folder: `.cursor/audit-reports/v195-neda-handoff-file-sync-and-usage/<run_id>/`

---

## Hard constraints (all Neda tasks)

- No production DB, no migrations/DDL apply
- No `package_items`, no `.from("returns")`
- No Amazon SP-API or OpenAI **calls** from verification scripts
- Staging ref `eiqfaapyumhixxoeltgu` in active env for runtime probes
