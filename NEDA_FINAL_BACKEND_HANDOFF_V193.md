# NEDA Final Backend Handoff V193

**Owner:** Main/user  
**Mode:** Agent, docs only  
**Run ID:** `20260521T193200Z`  
**Audience:** Neda, GPT, Cursor, Codex

This is the final authoritative backend handoff after product input auto lookup, resolver-on-save, product detail deep links, inventory view product-id alignment, expected-package map bridge, and Neda operator UI enforcement.

## Final Standard Path

Every product-aware flow must use the same path:

```text
operator/UI/API/import input
-> normalize identifiers
-> local product resolver first
-> products + product_identifier_map
-> gated backend enrichment only if no local match and gates allow it
-> persist resolved_product_id only when deterministic
-> hydrate ProductLinkageDisplayContract
-> render exact product detail links and fallback states everywhere
```

There is no alternate UI path, no browser product creation path, and no raw linked-looking display path.

## Product Code Input

Any product code input must follow this order:

1. Local lookup first through backend action `lookupProductInputForReturnItem`.
2. Normalize/classify FNSKU, ASIN, UPC/EAN/GTIN, SKU/MSKU.
3. Resolve through `product_identifier_map` and exact local `products` matches.
4. Use gated backend Amazon/product enrichment only when no local match exists and backend gates are explicitly enabled.
5. Never call Amazon or fake SP-API from the browser.
6. Never treat fake/mock SP-API data as real product evidence.

Backend enrichment gates remain:

```text
AMAZON_SP_API_ENABLED=true
PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED=true
NEXT_PUBLIC_SUPABASE_URL targets eiqfaapyumhixxoeltgu
```

If a gate is closed, the row remains unresolved/reviewable.

## Save And Edit

All save/edit writes are server action only.

- Add item: `insertReturn` normalizes identifiers, runs resolver-on-save, and persists `resolved_product_id` only for one deterministic winner.
- Edit item: `updateReturn` re-runs resolver when identifiers or org/store scope changed.
- Scanner save: server action wrapper only; no direct browser write.
- Imports/API/claims: governed backend resolver/import paths only.

No browser code may write product-aware rows, product linkage fields, or catalog rows directly.

## Read, Detail, Package, Pallet

All product-aware reads render through `ProductLinkageDisplayContract`.

- Return item detail uses hydrated product linkage.
- Package child item rows render through the same contract.
- Pallet drilldown child item rows render through the same contract.
- Claim and inventory product labels use the same display block.
- Resolved product labels link to `/pim/products/<product_id>`.
- Unresolved/ambiguous/mismatch rows do not link to a generic product list as if resolved.

## Expected Vs Scanned

Expected/scanned comparison is product identity first and deterministic fallback second:

1. canonical `resolved_product_id` / `products.id`
2. legacy scanned `product_id` only when no canonical resolved key exists
3. `fnsku`
4. `asin + sku`
5. `asin`
6. `sku`
7. `product_identifier`

If both sides have product IDs and they differ, raw identifier matches must not override the mismatch.

V193 inventory view product columns are applied on staging:

- `v_scanned_items_counted` exposes product ID/status/name columns and retains `deleted_at IS NULL`.
- `v_inventory_item_status` exposes product ID/status/quantity comparison columns.
- `v_inventory_status` remains package aggregate/chip data only.

## Missing Product

Missing product means unresolved unless trusted imported/API evidence creates the product spine through an approved backend path.

Allowed:

- Governed product/import waves with exact identifiers, approval, audit artifacts, and rollback.
- Approved E1 map bridge rows for existing products.

Forbidden:

- Product creation from title/OCR/free text/UI guess.
- Fuzzy auto-linking.
- AI/OpenAI auto-linking.
- Browser Amazon/API lookup.
- Fake SP-API data as product truth.

## Current Evidence Snapshot

| Area | Status |
|---|---|
| Product resolution contract guard | PASS, `523` files, `0` errors |
| Product input auto lookup V193 | PASS, backend action, local lookup first |
| Resolver-on-save | PASS, `insertReturn` / `updateReturn` |
| Product detail deep links V193 | PASS, `/pim/products/<product_id>` |
| Expected_packages E1 bridge | PASS, `134` map rows inserted |
| Expected_packages read-layer coverage | `1,517 / 1,626` resolved; `109` unresolved |
| Inventory view product-id columns V193 | PASS, staging DDL applied |
| AFI guarded Tier 3 | PASS, `14,693 / 19,503` resolved (`75.34%`) |
| Neda operator enforcement | Same path required for every operator/warehouse UI surface |

## Forbidden

- No `package_items`.
- No old `.from("returns")`.
- No direct browser DB writes for product-aware rows.
- No UI-side `products.insert` / `products.upsert`.
- No raw product-aware detail reads without `ProductLinkageDisplayContract`.
- No fake SP-API product truth.
- No title/OCR/fuzzy/AI auto-link.
- No production DB mutation without explicit approval.
- No migrations or DB writes from docs-only handoff prompts.

## Required Guard

Before handing off any product-aware UI/API/import/scanner change:

```bash
npm run check:product-resolution-contract-v192
```

The guard must stay green for Neda/Cursor/GPT work.

## Evidence

- `product-input-auto-lookup-enrichment-v193/20260521T184000Z/`
- `product-detail-deep-link-v193/20260521T185300Z/`
- `inventory-views-product-id-columns-v193/20260521T185800Z/`
- `expected-packages-e1-map-bridge-execute-v192/20260521T190300Z/`
- `backend-product-resolution-contract-lock-v192/20260521T012000Z/`
- `history-v192/20260527T120000Z/`
