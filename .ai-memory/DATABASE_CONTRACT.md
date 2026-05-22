# Database contract — V195 closeout + product resolution contract

Staging ref: **`eiqfaapyumhixxoeltgu`**  
Original ref: **`kxsvedvpjldygtdbylsy`**  
Future production project: **NOT_CREATED_YET / BLOCKED**

## Environment binding

| Surface | Target ref |
|---|---|
| Local dev | `eiqfaapyumhixxoeltgu` |
| Vercel Preview | `eiqfaapyumhixxoeltgu` |
| Vercel Production app | `kxsvedvpjldygtdbylsy` |
| Future production project | **NOT_CREATED_YET** |

Original/Vercel Production is not the future production cutover. Do not point Vercel Production at staging.

## Canonical product spine

| Object | Contract |
|---|---|
| `products` | Canonical product row; `products.id` is the first comparison key |
| `product_identifier_map` | Deterministic identifier bridge for ASIN/FNSKU/SKU/UPC/GTIN to product |

Do not create products automatically from OCR/title/free text/fuzzy/UI guesses. Product creation or promotion belongs to governed catalog/import/API-backed waves only.

## Product Resolution Contract — Non-Negotiable

All product-aware reads and writes must follow this path:

```text
Manual/UI/API/import input
-> normalize identifiers
-> local product resolver first
-> products + product_identifier_map
-> gated backend enrichment only if no local match and gates allow it
-> persist resolved_product_id only when deterministic
-> return/hydrate ProductLinkageDisplayContract
-> UI/detail/package/pallet/views render the same contract
```

Applies to manual add item, manual edit item, scanner save, package child items, pallet child items, return item detail, expected packages, slip contents, imports/Amazon files, API ingestion, claim generation, and Neda UI.

Allowed patterns:

- Approved server actions for product-aware writes.
- Resolver-on-save for created/changed identifiers.
- Governed import/resolver scripts with evidence and rollback.
- Read hydration through `ProductLinkageDisplayContract`.
- Explicit unresolved, ambiguous, and mismatch states.
- Exact product detail links to `/pim/products/<product_id>` for resolved products.

Forbidden patterns:

- Direct browser Supabase writes for product-aware rows.
- UI-side `products.insert` or `products.upsert`.
- `package_items`.
- Legacy `.from("returns")`.
- Raw `return_items` detail reads without product-linkage hydration.
- Title/OCR/fuzzy/AI auto-linking or product auto-create.
- Browser Amazon/API lookup and fake SP-API product truth.

Repo guard: `npm run check:product-resolution-contract-v192`.

## Canonical operational tables

| Object | Contract |
|---|---|
| `return_items` | Canonical scanned/item line table |
| `expected_packages` | Canonical expected package/item source for Neda expected views |
| `slip_contents` | Slip-line source and future governed UPC/GTIN enrichment source |
| `packages` / `pallets` | Parent hierarchy; child item display comes from `return_items` |

`package_items` is forbidden and must not be created or queried. Legacy `returns` must not be queried for line data.

## Add/edit resolver contract

- Add item goes through `insertReturn`, not direct browser DB writes.
- Edit item goes through `updateReturn`, not direct browser DB writes.
- Resolver inputs: `fnsku`, `asin`, `sku`, `product_identifier`, organization scope, and store scope.
- Persist `resolved_product_id` only for one deterministic product winner.
- No match: keep raw identifiers, clear product IDs, mark unresolved.
- Multiple winners: clear product IDs, mark ambiguous.
- Legacy/product conflict: clear product IDs, mark mismatch.

## Neda read/view contract

| Read/view | Contract |
|---|---|
| `v_scanned_items_counted` | Count active scanned `return_items`; preserve `deleted_at IS NULL` |
| `v_inventory_item_status` | Item-level expected/scanned status view with V193 product ID/status columns |
| `v_inventory_status` | Package-level aggregate/chip view only |
| `fetchExpectedPackagesNedaRead` | Approved read layer; emits product-key-first `product_comparison` |
| `fetchInventoryItemStatusForNeda` | Approved item read layer; emits hydrated linkage/display data |
| `ProductLinkageDisplayContract` | Canonical UI/API product display contract |

V193 view DDL is applied on staging. Item-level inventory views expose product ID/status/name columns; `v_inventory_status` remains package aggregate only.

## Expected vs scanned comparison

Priority:

1. canonical `resolved_product_id` / `products.id`
2. legacy scanned `product_id` only if no canonical resolved key exists
3. `fnsku`
4. `asin + sku`
5. `asin`
6. `sku`
7. `product_identifier`

If expected and scanned rows both have product identity and the products differ, raw identifier collisions do not override the mismatch.

## Current status

| Area | Status |
|---|---|
| `return_items` staging test cohort | `3` active, `3` resolved, `0` unresolved, `4` soft-deleted fake/test |
| Inventory V189 deleted filter | PASS on staging and original |
| V191 operator add/edit resolver | PASS; server actions only; no browser writes |
| V191 read-layer product-key alignment | PASS; no DDL applied |
| Expected packages product coverage | `1,574 / 1,626` read-layer resolved; `52` unresolved (V201) |
| V196 lookup ambiguous collapse | PASS — same `product_id` ties not ambiguous |
| V196 packaging model (plan) | `packaging_level` + `fulfillment_context`; versioned profiles; DDL V201 |
| V197 linkage census | PASS — read-only table matrix |
| AFI catalog coverage | `14,693 / 19,503` resolved (`75.34%`) |
| V192 contract guard | PASS after scanner save moved behind server action |
| V193 product input lookup | PASS: local first; gated backend enrichment only; no browser/fake SP-API |
| V193 product detail links | PASS: `/pim/products/<product_id>` |
| V193 inventory view columns | PASS: staging DDL applied |
| V195 inventory original parity | PASS on `kxsvedvpjldygtdbylsy`; product columns applied + verified |
| V194 lookup/link UI polish | PASS: timeout, Product column, source back links |
| V194 expected_packages E2 | PASS: 19 products + 19 map rows on staging |

## Forbidden / absent

| Name | Rule |
|---|---|
| `package_items` | Must not exist; do not create/query |
| legacy `returns` | Do not query for line data |
| direct browser DB write | Forbidden for linkage/catalog fields |
| production DB mutation | Forbidden without explicit approval |
| Amazon API / AI/OpenAI | Forbidden for this path unless separately approved |
| raw detail read without hydration | Forbidden for product-aware UI/detail/package/pallet surfaces |
| fake SP-API product data | Forbidden as product truth |

## Evidence

`NEDA_FINAL_BACKEND_HANDOFF_V193.md` · `history-v196/20260522T230000Z/` · `history-memory-v196-closeout/20260522T230000Z/` · `v196-item-name-upc-ambiguous-lookup-fix/20260519T223000Z/` · `v197-product-linkage-table-census/20260522T120000Z/` · `v199-expected-identifier-ambiguous-review-pack/20260522T130000Z/` · `expected-packages-e1-map-bridge-execute-v192/20260521T190300Z/` · `backend-product-resolution-contract-lock-v192/20260521T012000Z/`
