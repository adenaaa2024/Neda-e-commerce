# Schema inventory — product linkage (NEXT-SCANNER-02)

## Tables touched

| Table | Role | New / verified columns |
|-------|------|-------------------------|
| `expected_packages` | Removal expectation lines (scanner “expected” source) | `expected_product_id`, `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_*`, `product_match_status`, `product_review_required`, `product_resolved_at`, `product_resolved_by` |
| `return_items` | Physical units saved from scanner / returns UI | `expected_item_id` → `expected_packages.id`, plus mirrored resolution + match columns |
| `slip_contents` | BOX slip GPT lines per package | OCR/parsed tokens + resolution columns |
| `products` | Canonical catalog (existing) | Referenced by new nullable FKs only |
| `catalog_products` | Listing snapshots (existing) | Referenced by `resolved_catalog_product_id` |
| `product_identifier_map` | Identifier bridge (existing) | Read by resolver; no schema change |

## Not duplicated

- `return_items.product_id` — legacy column retained; new linkage uses `expected_product_id`, `scanned_product_id`, `resolved_product_id` per prompt.
- `slip_contents.description` — retained for slip text; `ocr_product_name` / `ocr_text` added for explicit OCR provenance when needed.
- `slip_contents.upc` / `fnsku` — retained; `parsed_*` columns hold normalized parser output when distinct.

## package_items

No columns added in this pass. Operator ITEM scan table remains `package_items` with existing shape; follow-up can mirror linkage if product identity is required per unit scan row.

## Extended PostgREST selects (post-migration)

- `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` in `lib/scanner/operator-tracking-expectations.ts`
- `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` in `app/returns/returns-constants.ts`

Default selects stay backward-compatible until operators apply the migration and optionally switch call sites.
