# Resolver helper check

## Module

- **File:** `lib/scanner/resolve-product-for-scanner-item.ts`
- **Export:** `resolveProductForScannerItem(supabase, input)`

## Alignment with constraints

| Constraint | Evidence |
|------------|----------|
| No Amazon API | No imports/calls to SP-API or Amazon clients |
| No OpenAI / AI | No LLM client usage |
| No product creation | No insert into `products` |
| No OCR/title-only resolution | `ocr_product_name` / `raw_text` only set `meta.ocr_ignored`; no match on title |
| Deterministic tiers | Reads `expected_packages` product columns, `product_identifier_map`, `products` by sku+store |

## New column usage

- Selects from `expected_packages` include `expected_product_id`, `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status` — consistent with migration-added columns.

## Status

Resolver helper is **present and consistent** with NEXT-SCANNER-02 design. Full behavior verification against live rows awaits staging migration + optional integration tests (suggested in NEXT-SCANNER-03).
