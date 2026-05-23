# NEDA expected packages + inventory views handoff (V179)

**Owner:** Neda  
**Audit:** `scanner-neda-17-expected-packages-inventory-views`  
**Mode:** Read-only UI consume — no EP client writes, no migrations

---

## Goal

Consume **`expected_packages`** (tracking/SKU model) and **`v_inventory_item_status`** on the operator-mobile identify gate and expected-inventory panels with variance + product linkage display.

---

## Read contracts (repo paths)

| Prompt / doc name | Implementation | Module |
|-------------------|----------------|--------|
| `fetchExpectedPackagesNedaRead` | `fetchExpectedPackagesForTracking`, `loadTrackingExpectationSnapshot`, `enrichTrackingOperatorLinesWithProductLinkage` | `lib/scanner/operator-tracking-expectations.ts` |
| EP display helpers | `buildExpectedPackageProductLinkage`, `formatScanVarianceLabel`, `mergeExpectedPackageRowsProductLinkage` | `lib/scanner/expected-packages-read-contract.ts` |
| `fetchInventoryItemStatusForNeda` | `fetchVInventoryStatusForScanCode`, `fetchVInventoryItemStatusLinesExact` | `lib/scanner/v-inventory-status.ts` |
| Inventory linkage merge | `buildInventoryViewProductLinkage` | `lib/scanner/expected-packages-read-contract.ts` |

Optional markdown aliases (not required if libs present):

- `expected-packages-neda-read-contract.md` → use `lib/scanner/expected-packages-read-contract.ts`
- `neda-inventory-read-contract.md` → use `lib/scanner/v-inventory-status.ts`

---

## UI surfaces (`app/scanner/operator-mobile/scan/page.tsx`)

| Surface | Symbols |
|---------|---------|
| Expected Inventory Summary | `ExpectedInventoryLineRow`, `OperatorProductLinkageMeta`, Exp/Scan/Var |
| Shipment lines table | `expectedPkgLines`, `formatScanVarianceLabel` |
| Identify gate | `fetchVInventoryStatusForScanCode` → `identifyGateShipmentLines` |
| Tracking operator lines | `loadTrackingExpectationSnapshot`, `line.product_linkage` |

---

## Scanned counts

- **Not** `v_scanned_items_counted` (not in repo)
- Use `fetchReturnItemsScannedBySkuFnsku*` on **`return_items`** (read-only helpers in tracking lib)

---

## Staging policy: `expected_packages`

On current staging, `expected_packages` is **SKU/tracking-first** — no `identifier_resolution_*` columns. Extended selects (`EP_*_WITH_SCANNER_PRODUCT_SELECT`) **42703-fallback** to base selects in `operator-tracking-expectations.ts`.

Product linkage badges for EP rows use **enriched display** from joined `products` when migration `20260717120000` is applied; until then, rely on SKU/FNSKU + slip text fallbacks.

---

## Forbidden

Same as V178: no `package_items`, no `.from("returns")`, no browser DB writes on scan page, no `products.insert`.

---

## Verification scripts

```bash
npx tsx scripts/scanner-neda-17-expected-packages-inventory-views.ts
npx tsx scripts/smoke-expected-packages-ui-wire-v179.ts
npx tsx scripts/smoke-inventory-views-ui-wire-v180.ts
npx tsx scripts/expected-inventory-neda-read-model-signoff-v181.ts
```

---

## Env / scope

- Staging ref: `eiqfaapyumhixxoeltgu` (`NEXT_PUBLIC_SUPABASE_URL` must classify STAGING_REF)
- Sam org/store: see `scripts/lib/neda-read-model-smoke-v181.ts`

---

## Related

- `NEDA_BACKEND_PRODUCT_LINKAGE_HANDOFF_V178.md` — slip/return_item linkage
- `.ai-memory/DATABASE_CONTRACT.md` — table names and forbidden patterns
