# Schema inventory — staging (PRODUCT-ID-LINKAGE-CLOSURE-V167)

**Project:** `kxsvedvpjldygtdbylsy` (from `.env.local`)  
**Probe:** PostgREST OpenAPI + `limit=0/1` SELECT (read-only)  
**Date:** 2026-05-18  
**Machine-readable:** `columns-live.json`, `probe-output.json`

## Summary

| Table / view | Live columns | Product FK / resolution cols | Verdict |
|--------------|-------------|------------------------------|---------|
| `products` | 42 | PK `id`; `asin`, `fnsku`, `sku`, `upc_code` | Target catalog — OK |
| `product_identifier_map` | 31 | `product_id`, `catalog_product_id`; identifier bridge | OK |
| `return_items` | 37 | **4 / 13** from migration `20260717120000` | Partial |
| `slip_contents` | 21 | **4 / 15** partial | Partial |
| `expected_packages` | 38 | **0 / 11** product linkage | SKU/FNSKU/tracking by design |
| `packages` | 26 | No product FK | OK (container only) |
| `claim_reference_edges` | 26 | No `product_id`; graph via `*_source_table` + row id | OK (indirect) |
| `raw_report_uploads` | 22 | Upload metadata only | OK |
| `catalog_products` | 30 | `product_id`, `linked_product_id`; listing identifiers | OK |
| `listing_raw_rows` | — | Not in PostgREST schema cache | Not probed via REST |
| `v_product_identity` | — | View **not** on staging (`PGRST205`) | Migration not applied |

---

## `products` (42 columns)

Canonical org/store catalog. Resolver uses `organization_id`, `store_id`, `sku`, `asin`, `fnsku`, `upc_code`, `deleted_at`. No `resolved_*` columns (not applicable).

---

## `product_identifier_map` (31 columns)

Bridge table for deterministic resolution. Present: `product_id`, `catalog_product_id`, `seller_sku`, `asin`, `fnsku`, `upc_code`, `confidence_score`, `resolution_status`, enrichment metadata (`msku`, `title`, `match_source`, `linked_from_*`, etc.).

---

## `return_items` (37 columns)

Physical units (scanner + returns). Legacy `product_id` present (often null). Identifier columns: `asin`, `fnsku`, `sku`, `product_identifier`.

**Linkage present (4):** `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`.

**Absent (migration `20260717120000`):** `expected_item_id`, `expected_product_id`, `scanned_product_id`, `identifier_resolution_source`, `identifier_resolution_meta`, `product_match_status`, `product_review_required`, `product_resolved_at`, `product_resolved_by`.

---

## `slip_contents` (21 columns)

BOX slip lines. Identifiers: `fnsku`, `upc`, `description` (not `asin`/`sku` columns on live DB).

**Linkage present (4):** same quartet as `return_items`.

**Absent:** `parsed_*`, OCR columns, `identifier_resolution_source`, `identifier_resolution_meta`, `product_review_required`.

---

## `expected_packages` (38 columns)

Removal expectation lines. Operational: `sku`, `fnsku`, `disposition`, `tracking_number`, `order_id`, `expected_scan_quantity`, `actual_scanned_count`, `id_slip_contents`, `store_id`, etc.

**No** `expected_product_id`, `resolved_product_id`, or resolution metadata on live DB. App uses `EP_SELECT` (SKU/FNSKU/tracking only) with intentional fallback when extended selects fail.

---

## `packages` (26 columns)

Shipment container. `tracking_number`, `package_code`, counts — no product linkage columns.

---

## `claim_reference_edges` (26 columns)

Claim graph edges: `from_source_table`, `from_source_row_id`, `to_source_table`, `to_source_row_id`, `reference_kind`, `reference_value`. Product linkage is **indirect** (row pointers), not denormalized `product_id`.

---

## Import-related

| Surface | Role |
|---------|------|
| `raw_report_uploads` | Upload job metadata; no per-line `product_id` |
| `product_identifier_map` | Populated by product-identity import (`scripts/import-product-identity.ts`, `import-actions.ts`) |
| `catalog_products` | `product_id` + `seller_sku` / `asin` / `fnsku` |
| `v_product_identity` | Unified read model in repo migration `20260630` — **not deployed** on this staging project |
