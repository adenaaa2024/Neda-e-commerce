# Tasks — active board (V191 item resolver milestone)

Synced with [`.ai-memory/NEXT_ACTIONS.md`](.ai-memory/NEXT_ACTIONS.md).

## Done — V191 item resolver

- [x] Operator item add/edit resolver standard **PASS**
- [x] No direct browser `return_items` writes on save paths
- [x] Detail / package / pallet linkage display **PASS**
- [x] Inventory read-layer product-key comparison **PASS**
- [x] History V191 + `.ai-memory` sync `20260526T120000Z`
- [x] AFI guarded Tier 3 SKU/no-ASIN-conflict execute **PASS** (109 rows)
- [x] Product resolution contract lock V192 **PASS**
- [x] Expected_packages E1 map bridge V192 preflight **PASS** (254 candidates; approval false)

## Done — prior milestone (V190)

- [x] V189 staging + original view filter
- [x] Preview staging quartet + redeploy (ENV-06B)
- [x] Return_items 3/3/0 + 4 soft-deleted
- [x] Neda runtime replay + NEDA-18 **PASS**
- [x] Neda final backend handoff V191 docs **PASS**

## P1 — Catalog & packages

- [ ] Expected_packages E1 map-only execute after approval (254 expected rows / 134 map rows)
- [ ] Expected_packages E2/E4 refresh after E1 execute
- [ ] Optional inventory view DDL after approval
- [ ] Remaining product catalog/import completeness cohorts under separate governance
- [ ] Keep `npm run check:product-resolution-contract-v192` passing on product-aware changes

## P2 — Claims & TRID

- [ ] Claim cleanup / regeneration (governed)
- [ ] TRID / reference graph

## P3 — Platform

- [ ] API / hardening
- [ ] AI layer (later)

## P0 — Policy

- [ ] Staging quartet `eiqfaapyumhixxoeltgu`
- [ ] No `package_items`; no `.from("returns")`
- [ ] Future production — **blocked**

## Forbidden

[`.ai-memory/FORBIDDEN_ACTIONS.md`](.ai-memory/FORBIDDEN_ACTIONS.md)
