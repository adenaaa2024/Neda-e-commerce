# `slip_contents` product linkage verification

## Write path (code)

| Step | Location | Behavior |
|------|----------|----------|
| Slip replace / vision save | `operator-store-actions.ts` | Bulk insert/replace slip rows, then `void enrichSlipContentsProductLinksAfterReplace(...)` |
| Enrichment | `lib/scanner/enrich-slip-contents-product-links.ts` | Per line: `resolveProductForScannerItem` (fnsku, upc, description) → linkage patch on matching `sort_index` |

Patch targets: `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`, `identifier_resolution_source` (with column fallback via `updateRowWithScannerLinkagePatch`).

## Live DB

| Check | Result |
|-------|--------|
| Core linkage SELECT | **PASS** |
| `identifier_resolution_source` | **FAIL** 42703 |
| `parsed_asin` … `parsed_upc` | **FAIL** 42703 |
| Rows with non-null `resolved_product_id` (sample n=5) | **0** |

Operator mobile slip display select (`operator-store-actions.ts` ~line 400) includes linkage quartet when columns exist.

## Verdict

| Check | Status |
|-------|--------|
| Code invokes slip enrichment after replace | **PASS** |
| Live schema supports core quartet | **PASS** |
| Live data shows resolved slip lines | **NOT OBSERVED** in sample (may be env/catalog gap) |
| OCR/parsed columns | **NOT ON DB** — migration pending |

**Conclusion:** Slip linkage **wired in app**, **partial schema**, **no resolved rows** in recent staging sample.
