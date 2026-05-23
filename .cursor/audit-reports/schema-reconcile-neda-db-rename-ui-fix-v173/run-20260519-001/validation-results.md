# Validation results — run-20260519-001

| Check | Result | Evidence |
|-------|--------|----------|
| Staging `PACKAGE_LIST_SELECT` probe | **PASS** | PostgREST select OK |
| Staging `PALLET_LIST_SELECT` probe | **PASS** | PostgREST select OK |
| `npm run build` | **PASS** | After `ProductsLookupClient` cast + confidence coercion in `operator-store-actions.ts` |
| `package_items` in `app/` | **PASS** | ripgrep: 0 |
| `.from("returns")` in `app/` | **PASS** | ripgrep: 0 |
| `products.insert` in `app/` | **PASS** | ripgrep: 0 |
| Neda operator-mobile contract | **PASS** (unchanged) | Scanner paths already canonical |
| Returns & Logistics page load | **NOT RUN** | Blocked on build + no live browser session this run |
| Scanner route load | **NOT RUN** | Same |
| Operable smoke script | **NOT RUN** | Same |

## Overall verdict

**PASS** (schema + build) — Returns list selects match staging; browser operable smoke not re-run this session.
