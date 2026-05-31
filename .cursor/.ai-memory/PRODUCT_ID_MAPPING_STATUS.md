# Product ID mapping status — PC Phase 01 closeout

**Staging:** `eiqfaapyumhixxoeltgu`  
**Branch:** `feature/product-canonicalization-v2`  
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

## Expected packages / slip contents / return_items (PC Phase 01)

| Source | PC01 baseline | Post-PC03B |
|---|---|---|
| `expected_packages` | 1,577 / 1,626 resolved; **49** unresolved | **1,583 / 1,626**; **43** unresolved |
| `return_items` | **5 / 12** read-layer; **7** unresolved | unchanged |
| `slip_contents` | **0 / 11** persisted; **11** unresolved | unchanged |
| AFI unresolved | **4,751** | separate catalog program |

### PC02 triage of 49 unresolved (baseline)

| Sub-wave | Rows | Action |
|----------|-----:|--------|
| wave_a_dirty_source | 38 | quarantine / fix identifiers |
| wave_b_source_disagreement | 6 | **closed** PC03B (+6 map rows) |
| wave_c_api_catalog_404 | 5 | manual PIM link |

### Prior executes (carried)

| Source | Status |
|---|---|
| E1 V192 map-only | 134 map rows |
| E2 V194 | 19 products + 19 maps |
| V200 E1B | 10 products + 10 maps; E1B cohort closed |
| PC03B | 6 map rows; no products; no expected_packages updates |

### PC02 SP-API evidence

- Plan cohort: **5 rows / 3 distinct ASINs**
- Env + credentials: **ready**
- Operator approval: **false** — no governed HTTP until `APPROVED_SP_API_EVIDENCE_DRY_RUN=true`
- PC02A/B (`20260523T030000Z` / `20260523T040000Z`): evidence-only HTTP; **0** product/map inserts; 404 cohort triaged
- PC02C (`20260523T050000Z`): 5-row manual review queue for ASIN correction
- Rule: **no Amazon API until evidence-only approval**; pass-1 no product creation

### PC04 packaging

- **Plan gate:** `product-packaging-schema-pc04-approval.md` default **false** at plan stage
- **Schema applied:** PC04A staging + PC04B original (tables + RLS); smoke **PASS**
- **Backfill (staging only):** PC05C — **191** active profiles; original schema has no backfill data
- Composite key: `packaging_level` + `fulfillment_context` (+ org/store/product)

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
- No Amazon API or AI/OpenAI for product resolution without PC02 evidence-only approval.
- No browser Amazon lookup or fake SP-API product data in item add/edit lookup.
- No production DB mutation.
- No work on `main` directly — use `feature/product-canonicalization-v2`.
- No raw detail/package/pallet product display without `ProductLinkageDisplayContract`.

## Evidence

`NEDA_FINAL_BACKEND_HANDOFF_V193.md` · `history-pc-phase-01/20260526T120000Z/` · `history-memory-pc-phase-01-closeout/20260526T120000Z/` · `pc01-product-canonicalization-baseline/20260522T230000Z/` · `pc06-db-parity-ledger-original-sync-plan/20260526T040000Z/` · `pc05c-product-packaging-backfill-scale-staging/20260523T220100Z/` · `pc03b-expected-packages-source-disagreement-map-execute/20260523T020000Z/`
