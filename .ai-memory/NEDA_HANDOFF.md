# Neda handoff — product resolution contract lock V192

**Staging / Preview:** `eiqfaapyumhixxoeltgu`  
**Production app DB:** `kxsvedvpjldygtdbylsy` (unchanged; not a cutover)  
**Future production project:** **NOT_CREATED_YET** / **BLOCKED**  
**Authoritative handoff:** [`../NEDA_FINAL_BACKEND_HANDOFF_V192.md`](../NEDA_FINAL_BACKEND_HANDOFF_V192.md)

## Product Resolution Contract — Non-Negotiable

Every Neda product-aware surface must follow this path:

```text
manual/UI/API/import input
-> normalize identifiers
-> product resolver
-> products + product_identifier_map
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

- Add item: UI -> approved server action `insertReturn` -> deterministic resolver -> persist `resolved_product_id` only when exactly one product wins.
- Edit item: UI -> approved server action `updateReturn` -> re-run resolver when identifiers or org/store scope changed.
- Scanner save: UI -> approved server action wrapper; no direct browser write for product-aware rows.
- Resolver inputs include `fnsku`, `asin`, `sku`, and `product_identifier` for UPC/GTIN/barcode.
- Unresolved, ambiguous, and mismatch outcomes must remain visible and reviewable.

## Detail, package, pallet

- Detail reads hydrated item data and renders `ProductLinkageDisplayContract`.
- Package detail child rows are `return_items` rendered through the same contract.
- Pallet drilldown shows package child `return_items` through the same contract.
- `v_inventory_status` is package aggregate/chip data only; item-level product display comes from item rows/read-layer hydration.

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
| V191 inventory read alignment | PASS: read-layer product-key comparison; no DDL applied |
| Expected package spine plan | `1,263 / 1,626` read-layer resolved; `363` unresolved for governed waves |
| Product catalog AFI | `14,693 / 19,503` resolved (`75.34%`); guarded Tier 3 execute `109` rows |
| V192 contract guard | PASS; scanner save moved behind server action |
| NEDA-20 | No artifact found in audit reports during V191 handoff creation |

## Missing product rule

Missing product means display unresolved now. Later catalog/import waves fill `products` and `product_identifier_map` with governed evidence and approval.

Do not auto-create products from OCR/title/free text, do not fuzzy-match, do not call Amazon API, and do not call AI/OpenAI.

## Forbidden

- No `package_items`.
- No legacy `.from("returns")`.
- No direct browser Supabase writes for linkage/catalog fields.
- No direct browser Supabase writes for product-aware rows.
- No UI-side `products.insert` / `products.upsert`.
- No raw `return_items` detail reads without `ProductLinkageDisplayContract` hydration.
- No production DB touch.
- No DB mutation, migration, Amazon API, or AI/OpenAI work for this docs-only handoff.

## Evidence

`NEDA_FINAL_BACKEND_HANDOFF_V192.md` · `history-v191/20260526T120000Z/` · `history-memory-after-v191-item-resolver/20260526T120000Z/` · `operator-item-add-edit-resolver-standard-v191/20260520T235500Z/` · `inventory-expected-return-product-id-view-alignment-v191/20260521T001108Z/` · `expected-packages-product-spine-completion-plan-v191/20260521T001400Z/` · `backend-product-resolution-contract-lock-v192/20260521T012000Z/`
