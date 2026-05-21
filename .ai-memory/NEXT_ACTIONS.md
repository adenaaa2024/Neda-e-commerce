# Next actions — V191 item resolver milestone

See [TASKS.md](../TASKS.md).

---

## Done — V191 item resolver + alignment

- [x] Operator item add/edit resolver standard **PASS** (`insertReturn` / `updateReturn`; 16/16 smoke)
- [x] Direct browser `return_items` writes on add/edit/save **blocked**
- [x] Detail / package / pallet hydrated linkage **PASS**
- [x] Inventory read-layer `product_comparison` alignment **PASS** (no DDL)
- [x] Neda final backend handoff V191 docs **PASS**
- [x] History V191 + memory sync `20260526T120000Z` **PASS**
- [x] AFI guarded Tier 3 SKU/no-ASIN-conflict execute **PASS** (`109` rows; coverage `75.34%`)
- [x] Product resolution contract lock V192 **PASS** (`check:product-resolution-contract-v192`)
- [x] Expected_packages E1 map bridge V192 preflight **PASS** (`254` candidates; approval false)

**Not next:** staging `return_items` test-cohort resolver re-execute.

**Not found:** NEDA-20 audit artifact.

---

## Program priorities

1. **Expected_packages E1 execute** — only after `.cursor/operator-approvals/expected-packages-e1-map-bridge-v192-approval.md` flags are flipped; current plan has **254** expected rows / **134** map rows.
2. **Inventory view DDL** (optional) — apply `ddl-plan.md` only after explicit approval; read layers already product-key-first.
3. **Expected_packages E2 / E4 refresh** — after E1 execute, recompute governed promotion/review counts.
4. **Remaining product catalog/import completeness** — separate governed cohorts only; no broad fuzzy/title/API/AI resolution.
5. **Claim cleanup / regeneration** (governed)
6. **TRID / reference graph**
7. **API / hardening**
8. **Keep V192 guard passing** on product-aware UI/API/import/scanner changes.
9. **AI layer** (later; default deny)

---

## Production (blocked)

Future production Supabase project **NOT_CREATED_YET**. Do not point Vercel Production at staging.
