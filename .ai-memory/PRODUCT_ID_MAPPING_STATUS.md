# Product ID mapping status — V192 contract lock

**Staging:** `eiqfaapyumhixxoeltgu`  
**Authoritative handoff:** [`../NEDA_FINAL_BACKEND_HANDOFF_V192.md`](../NEDA_FINAL_BACKEND_HANDOFF_V192.md)

## Canonical rule

Product identity is resolved through `products` + `product_identifier_map`. Operational rows should persist `resolved_product_id` only when a deterministic resolver proves exactly one product.

Missing product means unresolved display now; governed catalog/import waves fill the spine later.

## Product Resolution Contract — Non-Negotiable

All product-aware write paths must normalize identifiers, run the resolver, persist `resolved_product_id` only for one deterministic winner, and return/hydrate `ProductLinkageDisplayContract`. All product-aware read/detail/package/pallet/views must render that same contract.

Allowed:

- Approved server actions and governed import/resolver scripts.
- Resolver-on-save for manual add, manual edit, scanner save, imports, API ingestion, and claim generation.
- `ProductLinkageDisplayContract` hydration for reads.
- Visible unresolved/ambiguous/mismatch fallback states.

Forbidden:

- Direct browser Supabase writes for product-aware rows.
- UI-side `products.insert` / `products.upsert`.
- `package_items`.
- Legacy `.from("returns")`.
- Raw `return_items` detail reads without hydration.
- Title/OCR/fuzzy/AI auto-link or auto-create.

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

`fetchExpectedPackagesNedaRead` and `fetchInventoryItemStatusForNeda` emit the standardized `product_comparison` model. V191 did not apply database view DDL.

## Expected packages / slip contents

| Source | Status |
|---|---|
| `expected_packages` | `1,626` rows; `1,263` read-layer resolved; `363` unresolved |
| E1 V192 map-only plan | `254` candidate expected rows; `134` unique map insert-plan rows; approval false |
| E1 ambiguity exclusions | `10` rows |
| E2 plan | `29` governed product promotions from trusted import evidence only |
| E4 review | `117` rows for manual/API-evidence review |
| `slip_contents` | Small UPC/GTIN candidate source; no broad auto-promotion |

V192 E1 recompute differs from the V191 `217` row baseline because current staging was recomputed after subsequent product catalog resolver work, including AFI guarded Tier 3 execute. E1 remains map-only: no product creation and no `expected_packages` updates.

## Product catalog AFI

| Metric | Value |
|---|---:|
| Total AFI rows | 19,503 |
| Resolved | 14,693 |
| Unresolved | 4,810 |
| Coverage | 75.34% |
| Guarded Tier 3 executed | 109 |
| Products count before/after | 17,002 / 17,002 |
| `product_identifier_map` count before/after | 16,638 / 16,638 |

The guarded Tier 3 SKU/no-ASIN-conflict batch executed on staging in `product-catalog-afi-guarded-tier3-sku-no-asin-conflict-v191/20260521T010000Z`. It updated only `amazon_amazon_fulfilled_inventory` resolver columns, with `identifier_resolution_status = matched` and confidence `0.85`. No product creation, map inserts, migrations, production work, Amazon API, or AI/OpenAI occurred.

## Forbidden

- No `package_items`.
- No legacy `.from("returns")`.
- No direct browser Supabase writes for linkage/catalog fields.
- No auto-create products from OCR/title/free text.
- No fuzzy matching.
- No Amazon API or AI/OpenAI for product resolution.
- No production DB mutation.
- No raw detail/package/pallet product display without `ProductLinkageDisplayContract`.

## Evidence

`NEDA_FINAL_BACKEND_HANDOFF_V192.md` · `history-v191/20260526T120000Z/` · `history-memory-after-v191-item-resolver/20260526T120000Z/` · `operator-item-add-edit-resolver-standard-v191/20260520T235500Z/` · `inventory-expected-return-product-id-view-alignment-v191/20260521T001108Z/` · `expected-packages-product-spine-completion-plan-v191/20260521T001400Z/` · `expected-packages-e1-map-bridge-plan-v192/20260521T013000Z/` · `product-catalog-import-completeness-wave-190/20260524T180000Z/` · `product-catalog-afi-rebase-next-batch-v191/20260521T002400Z/` · `product-catalog-afi-guarded-tier3-sku-no-asin-conflict-v191/20260521T003300Z/` · `product-catalog-afi-guarded-tier3-sku-no-asin-conflict-v191/20260521T010000Z/` · `backend-product-resolution-contract-lock-v192/20260521T012000Z/`
