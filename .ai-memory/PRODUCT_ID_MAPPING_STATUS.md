# Product ID mapping status — V195 closeout

**Staging:** `eiqfaapyumhixxoeltgu`  
**Authoritative handoff:** [`../NEDA_FINAL_BACKEND_HANDOFF_V193.md`](../NEDA_FINAL_BACKEND_HANDOFF_V193.md)

## Canonical rule

Product identity is resolved through `products` + `product_identifier_map`. Operational rows should persist `resolved_product_id` only when a deterministic resolver proves exactly one product.

Missing product means unresolved display now unless trusted import/API evidence creates the product spine through an approved backend path.

## Product Resolution Contract — Non-Negotiable

All product-aware write paths must normalize identifiers, run local lookup/resolver first, persist `resolved_product_id` only for one deterministic winner, and return/hydrate `ProductLinkageDisplayContract`. All product-aware read/detail/package/pallet/views must render that same contract.

Allowed:

- Approved server actions and governed import/resolver scripts.
- Resolver-on-save for manual add, manual edit, scanner save, imports, API ingestion, and claim generation.
- `ProductLinkageDisplayContract` hydration for reads.
- Visible unresolved/ambiguous/mismatch fallback states.
- Gated backend enrichment only when local lookup fails and backend gates allow it.
- Exact product detail links to `/pim/products/<product_id>`.

Forbidden:

- Direct browser Supabase writes for product-aware rows.
- UI-side `products.insert` / `products.upsert`.
- `package_items`.
- Legacy `.from("returns")`.
- Raw `return_items` detail reads without hydration.
- Title/OCR/fuzzy/AI auto-link or auto-create.
- Browser Amazon/API lookup and fake SP-API product truth.

Guard: `npm run check:product-resolution-contract-v192`.

## return_items test cohort — closed

| Item | Status |
|---|---:|
| Active `return_items` | 3 |
| Resolved | 3 |
| Unresolved | 0 |
| Soft-deleted fake/test | 4 |

No staging test-cohort re-execute is required.

## Add/edit item resolver path

- Product barcode/code input lookup is server-side in V193: `lookupProductInputForReturnItem` normalizes ASIN/FNSKU/UPC/EAN/GTIN/SKU, local-resolves through map/products first, and returns `ProductLinkageDisplayContract`; add/edit save still re-runs resolver.
- Backend enrichment is gated by `AMAZON_SP_API_ENABLED`, `PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED`, and staging environment. Browser/fake SP-API lookup is forbidden.
- Add item: `insertReturn` normalizes identifiers and runs the deterministic resolver.
- Edit item: `updateReturn` re-runs the resolver when identifiers or org/store scope changed.
- Inputs include `fnsku`, `asin`, `sku`, and `product_identifier` for UPC/GTIN/barcode.
- One winner persists `resolved_product_id`.
- No winner, multiple winners, or mismatch clears product IDs and displays unresolved/review/mismatch.

## Expected/scanned product comparison

Read layers compare product identity first:

1. `resolved_product_id`
2. legacy scanned `product_id` only when no canonical key exists
3. `fnsku`
4. `asin + sku`
5. `asin`
6. `sku`
7. `product_identifier`

`fetchExpectedPackagesNedaRead` and `fetchInventoryItemStatusForNeda` emit the standardized `product_comparison` model. V193 inventory views now expose product ID/status columns on item-level views.

## Product detail links

Resolved `ProductLinkageDisplayContract` UI links route to `/pim/products/<product_id>`. Unresolved and ambiguous states remain reviewable and must not fall back to a generic product-list link.

V194 polish: product links carry source `back` context, stop row-click propagation, and product display has a first-class Product column in item/package/pallet tables. Barcode lookup has timeout/debounce handling to avoid stuck loading states.

V196: ambiguous lookup collapses duplicate map rows sharing one `product_id`; lookup returns UPC and canonical `item_name`; `AmbiguousProductPicker` for review. Browser proof superseded by V200/V202 **PASS**.

## Expected packages / slip contents

| Source | Status |
|---|---|
| `expected_packages` | `1,626` rows; `1,546` read-layer resolved; `80` unresolved |
| E1 V192 map-only execute | `134` map rows inserted; no products created; no `expected_packages` updates |
| E1 ambiguity exclusions | `10` rows |
| E2 V194 execute | `19` products + `19` map rows inserted; no `expected_packages` updates; no API call |
| V200 E1B blocker materialize | **PASS** — `10` products + `10` maps; scoped import FK remaps |
| E1B cohort | **CLOSED** — `28/28` read-layer resolved (`20260522T160000Z-e1b` skip pass) |
| expected_packages coverage | **1,574 / 1,626** read-layer; **52** unresolved |
| API/manual evidence | `46` identifier-only rows + `6` ambiguous rows remain |
| `slip_contents` | Small UPC/GTIN candidate source; no broad auto-promotion |

V192 E1 inserted only `product_identifier_map` rows from the approved plan. Products count and `expected_packages` count stayed unchanged.

V194 E2 inserted governed products/maps from trusted imported source names only. Amazon API was not called because the API approval flag was misspelled as `ture`.

## Product catalog AFI

| Metric | Value |
|---|---:|
| Total AFI rows | 19,503 |
| Resolved | 14,693 |
| Unresolved | 4,810 |
| Coverage | 75.34% |
| Guarded Tier 3 executed | 109 |
| Products count after E1/E2 (staging) | 17,021 |
| `product_identifier_map` active rows after E1/E2 | 16,791 |

The guarded Tier 3 SKU/no-ASIN-conflict batch executed on staging in `product-catalog-afi-guarded-tier3-sku-no-asin-conflict-v191/20260521T010000Z`. It updated only `amazon_amazon_fulfilled_inventory` resolver columns, with `identifier_resolution_status = matched` and confidence `0.85`. No product creation, map inserts, migrations, production work, Amazon API, or AI/OpenAI occurred.

## Forbidden

- No `package_items`.
- No legacy `.from("returns")`.
- No direct browser Supabase writes for linkage/catalog fields.
- No auto-create products from OCR/title/free text.
- No fuzzy matching.
- No Amazon API or AI/OpenAI for product resolution.
- No browser Amazon lookup or fake SP-API product data in item add/edit lookup.
- No production DB mutation.
- No raw detail/package/pallet product display without `ProductLinkageDisplayContract`.

## Evidence

`NEDA_FINAL_BACKEND_HANDOFF_V193.md` · `history-v196/20260522T230000Z/` · `history-memory-v196-closeout/20260522T230000Z/` · `v196-item-name-upc-ambiguous-lookup-fix/20260519T223000Z/` · `v196-vendor-category-cleanup-1883-plan/20260521T214500Z/` · `v197-product-linkage-table-census/20260522T120000Z/` · `v199-expected-identifier-ambiguous-review-pack/20260522T130000Z/` · `expected-packages-remaining-52-review-v201/20260522T170000Z/` · `expected-packages-e1b-blocker-materialize-execute-v200/20260522T160000Z/` · `product-linkage-browser-proof-signoff-v202/20260522T195000Z/`
