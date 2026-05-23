# Scanner readiness (SCANNER-02C)

## Overall

**Not ready for product-linkage persistence on the linked database** — migration not applied; live column presence unverified.

## Code / build readiness

| Area | Status | Notes |
|------|--------|-------|
| TypeScript | **Ready** | `npx tsc --noEmit` exit 0 |
| Production build | **Ready** | `npm run build` exit 0 (loads `.env.local`) |
| Resolver helpers | **Present** | `lib/scanner/resolve-product-for-scanner-item.ts`, enrichment PATCH helpers |
| Extended selects | **Guarded** | `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` and operator expectation selects documented as post-migration only |
| Legacy `returns` table name | **Clear** | No `.from("returns")`; `RETURN_ITEMS_TABLE = "return_items"` |

## Runtime / database readiness

| Area | Status | Notes |
|------|--------|-------|
| Product linkage columns on target DB | **Unknown** | Live verification skipped (env gate) |
| PostgREST extended SELECT/PATCH | **At risk** | Any code path using extended column lists will error until migration is applied on that project |
| Enrichment after insert/replace | **Best-effort no-op** | PATCH failures swallowed per NEXT-SCANNER-02; no data corruption expected |
| Scanner E2E smoke | **Not run** | Blocked: no confirmed dev/staging DB with verified schema |

## Dependency for Neda / NEXT-SCANNER-03

Extended UI and selects (NEXT-SCANNER-03) should not be treated as production-safe on the linked Supabase project until SCANNER-02C completes with **environment confirmed**, **migration applied**, and **live schema verification pass**.
