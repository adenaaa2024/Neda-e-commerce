# Validation results (SCANNER-NEDA-04)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1 | Open `/scanner/operator-mobile/scan` | **Pass** | Dev server `GET …/scan 200`; route in production build output |
| 2 | No `package_items table not available` | **Pass** | No runtime string in app; dev terminal has no `package_items` errors; live DB has no `package_items` table (PGRST205) — app uses `return_items` |
| 3 | No PostgREST 42703 on operator-mobile SELECT paths | **Pass** | `return_items` item-scan select OK; `EP_SELECT` / `EP_DETAIL_SELECT` OK; `slip_contents` resolves via fallback chain (attempt 6/6) |
| 4 | Identify gate on known tracking/package | **Partial** | Fixture package `9528d923…` tracking `123`, 2 slip lines; **0** `expected_packages` rows for that tracking on linked DB |
| 5 | Expected boxes/items load | **Pass (fixture)** | Read-only hydration: 2 `slip_contents` rows, 0 `return_items`; no query errors |
| 6 | Receive/save path does not crash | **Pass (static + dev)** | `insertOperatorPackageItemAction` → `insertReturn` on `return_items`; dev `POST …/scan 200` during session; **no insert probe** (no broad writes) |
| 7 | `return_items` / `slip_contents` product linkage | **Pass (return_items)** | `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` probe OK; EP extended linkage selects still **fail** (42703, pre-migration) — not used by repaired item-scan list |
| 8 | Neda UI layout/workflow preserved | **Pass (static)** | `identifyGatePhase`, `flowPhase`, `ScannerBottomNav`, `itemScanPackageId` hydration unchanged in `scan/page.tsx` |

## Tooling

| Command | Result |
|---------|--------|
| `npx tsx scripts/scanner-neda-04-operator-mobile-smoke.ts` | **Exit 0** — see `probe-output.json` |
| `npm run build` | **Pass** |
| `npx tsx scripts/next-scanner-04-staging-e2e.ts` | **Exit 1** — extended EP selects 42703 (known pre-linkage migration); `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` OK |

## Dev session evidence

Terminal log (local `npm run dev`): repeated `GET` / `POST /scanner/operator-mobile/scan` **200**, org `7397edff-…`, no `42703` or `package_items` log lines.
