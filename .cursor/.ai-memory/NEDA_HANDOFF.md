# Neda handoff — final backend path V193

**Staging / Preview:** `eiqfaapyumhixxoeltgu`  
**Production app DB:** `kxsvedvpjldygtdbylsy` (unchanged; not a cutover)  
**Future production project:** **NOT_CREATED_YET** / **BLOCKED**  
**Authoritative handoff:** [`../NEDA_FINAL_BACKEND_HANDOFF_V193.md`](../NEDA_FINAL_BACKEND_HANDOFF_V193.md)

## Product Resolution Contract — Non-Negotiable

Every Neda product-aware surface must follow this path:

```text
manual/UI/API/import input
-> normalize identifiers
-> local product resolver first
-> products + product_identifier_map
-> gated backend enrichment only if no local match and gates allow it
-> persist resolved_product_id only when deterministic
-> hydrate ProductLinkageDisplayContract
-> render the same contract everywhere
```

This applies to manual add, manual edit, scanner save, item detail, package child rows, pallet child rows, expected packages, slip contents, imports, API ingestion, and claim generation.

## Standard path

Neda-facing item/product display uses one backend path:

1. Product spine: `products` + `product_identifier_map`.
2. Item rows: `return_items`.
3. Expected rows: `expected_packages`.
4. Slip rows: `slip_contents`.
5. Display contract: `ProductLinkageDisplayContract`.
6. Expected/scanned read layers: `fetchExpectedPackagesNedaRead` and `fetchInventoryItemStatusForNeda`.
7. Views: `v_scanned_items_counted`, `v_inventory_status`, `v_inventory_item_status`.

## Add and edit

- Product barcode/code lookup is automatic through backend action `lookupProductInputForReturnItem` on blur/scan/paste/Enter.
- Lookup normalizes FNSKU, ASIN, UPC/EAN/GTIN, and SKU/MSKU; local resolver/map/products are checked first.
- V194 adds timeout/debounce handling so lookup does not stay stuck on loading; disabled enrichment returns an unresolved reason.
- Gated backend Amazon/product enrichment is allowed only when no local match exists and backend gates are enabled.
- Browser Amazon/mock/fake SP-API lookup is forbidden.
- Add item: UI -> approved server action `insertReturn` -> deterministic resolver -> persist `resolved_product_id` only when exactly one product wins.
- Edit item: UI -> approved server action `updateReturn` -> re-run resolver when identifiers or org/store scope changed.
- Scanner save: UI -> approved server action wrapper; no direct browser write for product-aware rows.
- Resolver inputs include `fnsku`, `asin`, `sku`, and `product_identifier` for UPC/GTIN/barcode.
- Unresolved, ambiguous, and mismatch outcomes must remain visible and reviewable.

## Detail, package, pallet

- Detail reads hydrated item data and renders `ProductLinkageDisplayContract`.
- Package detail child rows are `return_items` rendered through the same contract.
- Pallet drilldown shows package child `return_items` through the same contract.
- Resolved product labels/IDs link to `/pim/products/<product_id>?back=<source>` and stop row-click propagation; unresolved rows do not link to the generic product list.
- Returns/package/pallet item tables have a separate Product column; identifiers remain separate.
- `v_inventory_status` is package aggregate/chip data only; item-level product display comes from item rows/read-layer hydration.
- **CORRECTED (2026-06-07):** V193 view DDL was applied historically but **carrier-normalization DDL later overwrote** the three inventory views on staging. Staging execute `db-parity-view-linkage-slip-columns-staging-execute/20260529T231120Z/` **restored** product-id/status/name linkage on item-level views; original mirror **PENDING**.

## Expected vs scanned

Compare product identity first, fallback identifiers second:

1. `resolved_product_id` / canonical `products.id`
2. legacy scanned `product_id` only when no canonical resolved key exists
3. `fnsku`
4. `asin + sku`
5. `asin`
6. `sku`
7. `product_identifier`

If both sides have product IDs and they differ, do not let matching raw identifiers override the mismatch.

## Status snapshot

| Area | Status |
|---|---|
| V190 return_items/Neda milestone | PASS: `3` active, `3` resolved, `0` unresolved, `4` soft-deleted fake/test |
| V191 add/edit resolver standard | PASS: server actions and deterministic resolver path documented |
| V191 package/pallet/detail proof | PASS: shared `ProductLinkageDisplayContract` path |
| V193 inventory view product-id columns | **CORRECTED:** restored staging `20260529T231120Z` after carrier-normalization overwrite; original **PENDING** |
| Expected package E1 map bridge | PASS: `134` map rows inserted; no products or expected rows updated |
| Expected package coverage | `1,574 / 1,626` read-layer (post-V200 E1B); **52** unresolved (V201) |
| V196 lookup item_name/UPC/ambiguous | **PASS** code; UPC field; ambiguous picker; collapse same-product_id |
| V196 vendor 1883 plan | **Plan** — supplier code 1883; allowlist + display name |
| V196 packaging model | **Plan** — `packaging_level` + `fulfillment_context`; DDL V201 |
| V197 linkage census | **PASS** — table priority matrix |
| Product catalog AFI | `14,693 / 19,503` resolved (`75.34%`); guarded Tier 3 execute `109` rows |
| V192 contract guard | PASS; scanner save moved behind server action |
| Product input auto lookup V193 | PASS: local first, backend gated, no browser/fake SP-API |
| Product detail links V193 | PASS: `/pim/products/<product_id>` |
| Neda operator enforcement | Same path required for all operator/warehouse UI surfaces |
| Neda V23 / NEDA-23 | No separate audit artifact; rules in `NEDA_FINAL_BACKEND_HANDOFF_V193.md` |
| Neda V194 UI polish | **PASS** via `v194-lookup-stuck-link-ui-polish` (timeout, Product column, back links); no separate Neda V194 audit |
| V195 original view parity | **APPLIED_VERIFIED** on `kxsvedvpjldygtdbylsy`; staging + original item views aligned |
| V195 returns edit route | **PASS** — menu Edit opens drawer in edit mode; save via `updateReturn` |
| V202 / V200 lookup browser proof | **PASS** — 11/11 UI + 7/7 preflight (`v200-product-lookup-browser-proof-complete/20260522T195000Z/`) |
| V195 lookup browser proof | **SUPERSEDED** — was CONDITIONAL_PASS (auth only) |
| Neda V195 handoff file | **NOT_FOUND** — this closeout synced `.ai-memory` only |

## Missing product rule

Missing product means display unresolved now. Later catalog/import waves fill `products` and `product_identifier_map` with governed evidence and approval.

Do not auto-create products from OCR/title/free text, do not fuzzy-match, do not call Amazon API, and do not call AI/OpenAI.

V193 exception path: backend enrichment is allowed only if staging/server gates are enabled (`AMAZON_SP_API_ENABLED` and `PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED`). The browser must not call Amazon and must not use fake SP-API data.

## Forbidden

- No `package_items`.
- No legacy `.from("returns")`.
- No direct browser Supabase writes for linkage/catalog fields.
- No direct browser Supabase writes for product-aware rows.
- No UI-side `products.insert` / `products.upsert`.
- No raw `return_items` detail reads without `ProductLinkageDisplayContract` hydration.
- No fake SP-API data as product truth.
- No title/OCR/fuzzy/AI auto-link.
- No production DB touch.
- No DB mutation, migration, Amazon API, or AI/OpenAI work for this docs-only handoff.

## Pre-Neda merge gate (2026-06-16)

**Before merge with Neda:** run **PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE**.

| Prerequisite | Status |
|--------------|--------|
| Automation API Center | **COMPLETE** |
| Imports file-only cutover | **COMPLETE** |
| Scanner/RI physical-only architecture | **LOCKED** |
| Delete/move/void backend parity | **COMPLETE** (staging) |
| Product Core resolver | **Do not rewrite** |
| Product sheet sample wave | **0 creates** |
| Claims returns-first draft E2E | **BLOCKED** |
| Merge to main | **NO** until QA gate passes |

Branch: `feature/phase1-latest-stash-land` @ `999f765`

---

## Neda merge contract (2026-06-17 — LOCKED)

When merge is approved, Neda integration **must preserve**:

1. **Scanner UX** — operator-mobile receive, delete, move, void flows  
2. **Phase1 governed allocation/release rules** — `allocate_expected_items_for_return_item_ids`, `release_expected_item_unit`, `move_expected_item_unit`; physical-only `return_items`; no bulk RI; no EP→RI product copy without proven scan  

**No original DB DDL** without separate operator approval.

**Demo readiness:** [PHASE1_DEMO_READY.md](PHASE1_DEMO_READY.md)

## Evidence

`NEDA_FINAL_BACKEND_HANDOFF_V193.md` · `history-v196/20260522T230000Z/` · `history-memory-v196-closeout/20260522T230000Z/` · `v196-item-name-upc-ambiguous-lookup-fix/20260519T223000Z/` · `v197-product-linkage-table-census/20260522T120000Z/` · `product-linkage-browser-proof-signoff-v202/20260522T195000Z/` · `v200-product-lookup-browser-proof-complete/20260522T195000Z/`
