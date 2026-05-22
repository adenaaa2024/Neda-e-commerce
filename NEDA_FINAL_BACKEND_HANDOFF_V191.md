# NEDA Final Backend Handoff V191

**Owner:** Main/user  
**Mode:** Agent, docs only  
**Run ID:** `20260521T004000Z`  
**Audience:** Neda, GPT, Cursor

This is the simple authoritative backend path for Neda-facing returns, inventory, package, pallet, detail, expected/scanned, and product-linkage UI work.

## One-Screen Rule

Every item display starts from the canonical product spine and the canonical item row:

- Product spine: `products` + `product_identifier_map`
- Item table: `return_items`
- Expected source: `expected_packages`
- Slip source: `slip_contents`
- Display contract: `ProductLinkageDisplayContract`

If a product cannot be resolved deterministically, show it as unresolved. Do not create a product from UI text, OCR, barcode guesswork, fuzzy matching, Amazon API, or AI.

## Canonical Backend Objects

| Concern | Canonical object | Use |
|---|---|---|
| Product identity | `products.id` | The product key to compare first |
| Identifier bridge | `product_identifier_map` | Deterministic ASIN/FNSKU/SKU/UPC/GTIN to product resolution |
| Scanned/item rows | `return_items` | Canonical line-level return/scanner item table |
| Expected rows | `expected_packages` | Expected package/item source for Neda expected views |
| Slip rows | `slip_contents` | Slip-line source and future UPC/GTIN enrichment source |
| Counted scanned view | `v_scanned_items_counted` | Count active scanned `return_items`; must preserve `deleted_at IS NULL` |
| Package aggregate view | `v_inventory_status` | Package-level expected/scanned chip aggregates only |
| Item status view | `v_inventory_item_status` | Item-level expected/scanned status rows |

The current approved read layer aligns expected/scanned comparison around product keys first, then deterministic identifier fallbacks. Database view DDL for product-key grouping was planned but not applied in V191.

## Display Path

Neda UI should render product linkage only through hydrated `ProductLinkageDisplayContract` data.

- Detail: read a hydrated return item row and render the `ProductLinkageDisplayContract`.
- Package detail: show child `return_items` rows through the same contract.
- Pallet detail: drill into package child rows and show the same contract.
- Inventory item status: use `fetchInventoryItemStatusForNeda`, which emits item rows plus product comparison/display data.
- Expected packages: use `fetchExpectedPackagesNedaRead`, which emits expected rows plus `product_comparison`.

Do not invent separate DTOs for product display. The safe labels remain:

- Resolved: show the linked product.
- Unresolved: show `No product link yet`.
- Ambiguous/review: show `Needs review`.
- Mismatch: show mismatch/review state; do not silently choose one.

## Add Item Path

Add item must use the server action path:

1. UI collects identifiers such as `fnsku`, `asin`, `sku`, and `product_identifier` (UPC/GTIN/barcode).
2. UI calls the approved server action (`insertReturn`).
3. Server action normalizes identifiers.
4. Server action calls the deterministic resolver.
5. If exactly one product wins, persist `resolved_product_id` and related resolver metadata.
6. If no product wins, persist the raw identifiers and mark unresolved.
7. If multiple products win or legacy data conflicts, mark ambiguous/mismatch and leave product IDs null.

The add path must not write directly from the browser to Supabase for linkage/catalog fields.

## Edit Item Path

Edit item must use the server action path:

1. UI calls the approved server action (`updateReturn`).
2. If any resolver input changed (`fnsku`, `asin`, `sku`, `product_identifier`, org/store scope), re-run the resolver.
3. Persist a deterministic single winner as `resolved_product_id`.
4. Clear product IDs and mark unresolved/ambiguous/mismatch when the resolver cannot prove one product.

Do not preserve a stale product link after identifiers changed.

## Package, Pallet, And Detail

Package and pallet screens do not have a separate product-linkage backend.

- Parent package/pallet data provides hierarchy.
- Child rows are `return_items`.
- Each child item displays through `ProductLinkageDisplayContract`.
- Package-level chips from `v_inventory_status` are aggregates only; item product display belongs to item rows.

## Expected Vs Scanned

Expected/scanned comparison uses this priority:

1. Compare canonical `products.id` / `resolved_product_id` first.
2. For scanned rows that still have legacy `product_id`, use it only as a compatibility product key when no canonical resolved key is present.
3. If product identity is missing, fall back to deterministic identifiers in priority order:
   - `fnsku`
   - `asin + sku`
   - `asin`
   - `sku`
   - `product_identifier`
4. If both sides have product identity and those identities differ, do not let matching raw identifiers override the mismatch.

Unresolved expected or scanned rows stay visible and reviewable.

## Missing Product Rule

Missing product means: display unresolved now; later catalog/import waves fill the spine.

Allowed future spine work:

- Add `product_identifier_map` rows only when an existing product identity is proven.
- Promote/create products only through governed catalog/import waves with evidence, rollback, and operator approval.

Forbidden missing-product behavior:

- No auto-create from OCR/title/free text.
- No fuzzy matching.
- No live Amazon API call.
- No AI/OpenAI product inference.

## Current Evidence Snapshot

- V190 return item/Neda milestone: staging test cohort is closed with `3` active `return_items`, `3` resolved, `0` unresolved, and `4` soft-deleted fake/test rows excluded from views.
- V191 add/edit resolver standard: add and edit use server actions; resolver inputs include FNSKU, ASIN, SKU, UPC/GTIN/barcode via `product_identifier`; deterministic single winners persist `resolved_product_id`.
- V191 package/pallet/detail proof: top-level items, item detail, package child rows, and pallet drilldown render through the same product linkage contract.
- V191 inventory alignment: approved read layers compare expected/scanned by product key first and fallback identifiers second; no view DDL was applied.
- V191 expected package spine plan: `expected_packages` has `1,626` rows; read layer resolves `1,263`; `363` remain unresolved for governed E1/E2/E4 work.
- V190/V191 product catalog work: AFI coverage is `14,584 / 19,503` resolved (`74.78%`); guarded Tier 3 preflight found `109` SKU-only/no-ASIN-conflict candidates; approval defaults remain false.
- No `NEDA-20` artifact was found in the audit reports during this docs-only handoff run.

## Forbidden

Never do these in Neda/backend/UI work:

- Do not create, query, or depend on `package_items`.
- Do not query old `.from("returns")`; use `return_items`.
- Do not write product linkage/catalog fields directly from the browser.
- Do not auto-create `products` from OCR/title/free text.
- Do not fuzzy-match product identity.
- Do not call Amazon API for this path.
- Do not call AI/OpenAI for this path.
- Do not mutate production.
- Do not apply DB migrations or data writes without explicit approval.

## Source Evidence

- `.cursor/audit-reports/history-v190/20260525T120000Z/`
- `.ai-memory/NEDA_HANDOFF.md`
- `.cursor/audit-reports/operator-item-add-edit-resolver-standard-v191/20260520T235500Z/`
- `.cursor/audit-reports/inventory-expected-return-product-id-view-alignment-v191/20260521T001108Z/`
- `.cursor/audit-reports/expected-packages-product-spine-completion-plan-v191/20260521T001400Z/`
- `.cursor/audit-reports/product-catalog-import-completeness-wave-190/20260524T180000Z/`
- `.cursor/audit-reports/product-catalog-afi-rebase-next-batch-v191/20260521T002400Z/`
- `.cursor/audit-reports/product-catalog-afi-guarded-tier3-sku-no-asin-conflict-v191/20260521T003300Z/`
