# Scanner → `return_items` product linkage verification

## Write path (code)

| Step | Location | Behavior |
|------|----------|----------|
| Insert core row | `insertReturn` in `app/returns/actions.ts` | Writes identifiers (`asin`, `fnsku`, `sku`); does **not** set `product_id` or `resolved_product_id` on insert |
| Post-insert enrichment | `applyReturnItemProductEnrichmentAfterInsert` | Calls `resolveProductForScannerItem` → `updateRowWithScannerLinkagePatch` with `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`, `identifier_resolution_source` |
| Operator receive (batch) | `receiveOperatorExpectedPackageItemsAction` in `item-actions.ts` | Same `insertReturn` + enrichment per line |
| Operator item scan | `insertOperatorPackageItemAction` → `insertReturn` | Same enrichment hook |
| Manual override | `manualOverrideReturnItemProductResolution` | Sets `resolved_product_id`, status `resolved`, source `manual_override` (falls back if `identifier_resolution_source` missing) |

Resolver contract (`lib/scanner/resolve-product-for-scanner-item.ts`): deterministic only; **no** product creation; order: `product_identifier_map` → UPC → direct `products` match.

## Live DB evidence (staging sample)

| Cohort | Count (sample) | Notes |
|--------|----------------|-------|
| Rows with non-null `resolved_product_id` | 1 (recent sample limit 5) | Example: FNSKU `X004DMS1TT`, status `resolved`, `product_id` null |
| Recent rows, null `resolved_product_id` | 3 | Includes neda-06 smoke row `ccffe8b3-…` (FNSKU `X004N9OS4J`, all linkage null) |

## SELECT probes

| Probe | Result |
|-------|--------|
| `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` | **PASS** |
| `RETURN_SCANNER_LINKAGE_SELECT` (core quartet) | **PASS** |
| `identifier_resolution_source` column | **FAIL** 42703 |

## Verdict

| Check | Status |
|-------|--------|
| Code path invokes enrichment after every `insertReturn` | **PASS** |
| Writes use `resolved_product_id` (not auto `product_id`) | **PASS** (by design) |
| Full enrichment payload persists on staging | **PARTIAL** — core 4 columns only; `identifier_resolution_source` dropped by DB |
| Recent operator smoke row shows resolution | **FAIL** on fixture row (null linkage) — enrichment ran but no bridge match or UPDATE partial failure |

**Conclusion:** Scanner **attempts** product linkage on `return_items` via post-insert patch. Closure requires migration for missing columns and/or verified map hits on staging fixtures.
