# Schema inventory — live DB (SCANNER-NEDA-02)

**Project:** `kxsvedvpjldygtdbylsy` (from `.env.local`)  
**Probe:** PostgREST OpenAPI + `limit=0` SELECT (read-only)  
**Date:** 2026-05-18

Machine-readable column list: `columns-live.json`.

## Summary

| Table | Live column count | Scanner linkage (20260717120000) | Notes |
|-------|-------------------|-----------------------------------|-------|
| `expected_packages` | 38 | **0 / 11** | No product linkage columns |
| `return_items` | 37 | **4 / 13** partial | Core returns columns OK |
| `slip_contents` | 21 | **4 / 15** partial | `notes` not on live DB |
| `products` | 42 | N/A (target FK table) | Resolver direct-match OK |
| `product_identifier_map` | 31 | N/A (bridge table) | Resolver bridge OK |

---

## `expected_packages` (38 columns)

Operational removal expectation lines. Includes warehouse scan fields (`expected_scan_quantity`, `actual_scanned_count`, `fnsku`, `id_slip_contents`, `build_source`, `store_id`, etc.).

**Does not include:** `asin` (referenced in app `EP_SELECT` but absent on live DB).

**Does not include:** any `20260717120000` linkage columns.

---

## `return_items` (37 columns)

Physical return / scanner unit rows (renamed from `returns`). Core identifier and workflow columns present: `asin`, `fnsku`, `sku`, `product_identifier`, `conditions`, `expiration_date`, `expected_item_id` **absent**, legacy `product_id` present.

**Partial linkage present (4):** `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`.

**Absent from migration package (9):** `expected_item_id`, `expected_product_id`, `scanned_product_id`, `identifier_resolution_source`, `identifier_resolution_meta`, `product_match_status`, `product_review_required`, `product_resolved_at`, `product_resolved_by`.

---

## `slip_contents` (21 columns)

BOX slip lines per package. Includes `package_code`, `slip_code`, `order_id`, `conflicting_order_id`, `organization_id`, `store_id`, `created_by`.

**Partial linkage present (4):** same quartet as `return_items`.

**Absent:** OCR/parsed columns (`ocr_text`, `ocr_product_name`, `ocr_confidence`, `parsed_*`), `identifier_resolution_source`, `identifier_resolution_meta`, `product_review_required`.

**Code/types drift:** `types/database.types.ts` and migration `20260641130000_slip_contents_notes.sql` expect `notes`; column **not** on live DB (SELECT fails).

---

## `products` (42 columns)

Canonical catalog. Store-scoped identity: `organization_id`, `store_id`, `sku`, plus `asin`, `fnsku`, `upc_code`, `barcode`, `product_name`, `deleted_at`, merge fields, catalog sync metadata.

Used by `resolveProductForScannerItem` direct `products` match (org + store + sku).

---

## `product_identifier_map` (31 columns)

Identifier bridge. Resolver-critical columns present: `product_id`, `catalog_product_id`, `seller_sku`, `asin`, `fnsku`, `upc_code`, `store_id`, `organization_id`, `deleted_at`, `is_primary`, `confidence_score`, `resolution_status`.

Ledger-enrichment columns present: `msku`, `title`, `disposition`, `match_source`, `inventory_source`, `linked_from_*`, `source_file_sha256`, etc.
