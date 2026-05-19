# `expected_packages` — intentional SKU / tracking model

## Live schema

- **38 columns** on staging; includes `sku`, `fnsku`, `disposition`, `tracking_number`, `order_id`, `expected_scan_quantity`, `actual_scanned_count`, `store_id`, `id_slip_contents`.
- **No** `expected_product_id`, `resolved_product_id`, `resolved_catalog_product_id`, or `identifier_resolution_*` columns.
- **No** `asin` column on live DB (app `EP_SELECT` does not reference `asin`; tracking aggregate uses sku/fnsku/disposition only).

## App contract

| Select | Used when | Staging probe |
|--------|-----------|---------------|
| `EP_SELECT` | Identify gate, tracking aggregates | **PASS** |
| `EP_DETAIL_SELECT` | Item scan detail fetch | **PASS** |
| `EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT` | After full migration | **FAIL** 42703 |
| `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` | Extended detail | **FAIL** 42703 |

`lib/scanner/operator-tracking-expectations.ts` documents extended selects behind `20260717120000` and implements **fallback** to base selects when PostgREST returns 42703.

`resolveProductForScannerItem` explicitly notes: EP id is context only; **no product columns on live EP**.

## Policy verdict

| Question | Answer |
|----------|--------|
| Should `expected_packages` carry product FK today? | **No** on staging — intentional until migration approved |
| How are expectations matched to catalog? | SKU + FNSKU + disposition (+ tracking); scanned counts from `return_items` |
| Is this a blocker for scanner v165? | **No** — identify/receive flows use SKU/FNSKU paths |
| When to add product FK? | After operator-approved apply of `20260717120000` |

**PASS** — `expected_packages` correctly remains identifier/tracking-first without product FK on current staging.
