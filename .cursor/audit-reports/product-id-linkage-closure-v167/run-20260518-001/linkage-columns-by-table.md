# Linkage column matrix — live staging

Tracked fields from audit scope. **present** = column exists on live DB (OpenAPI); **absent** = not exposed.

## Core FK / resolution

| Column | products | product_identifier_map | return_items | slip_contents | expected_packages | packages | claim_reference_edges | catalog_products |
|--------|----------|------------------------|--------------|---------------|-------------------|----------|----------------------|------------------|
| `product_id` | — (use `id`) | present | present (legacy) | absent | absent | absent | absent | present |
| `catalog_product_id` | absent | present | absent | absent | absent | absent | absent | absent |
| `expected_product_id` | absent | absent | absent | absent | absent | absent | absent | absent |
| `scanned_product_id` | absent | absent | absent | absent | absent | absent | absent | absent |
| `resolved_product_id` | absent | absent | **present** | **present** | absent | absent | absent | absent |
| `resolved_catalog_product_id` | absent | absent | **present** | **present** | absent | absent | absent | absent |
| `identifier_resolution_status` | absent | absent | **present** | **present** | absent | absent | absent | absent |
| `identifier_resolution_confidence` | absent | absent | **present** | **present** | absent | absent | absent | absent |
| `identifier_resolution_source` | absent | absent | absent | absent | absent | absent | absent | absent |
| `identifier_resolution_meta` | absent | absent | absent | absent | absent | absent | absent | absent |
| `product_match_status` | absent | absent | absent | absent | absent | absent | absent | absent |
| `product_review_required` | absent | absent | absent | absent | absent | absent | absent | absent |

## Identifier tokens

| Column | products | product_identifier_map | return_items | slip_contents | expected_packages |
|--------|----------|------------------------|--------------|---------------|-------------------|
| `asin` | present | present | present | absent | absent |
| `fnsku` | present | present | present | present | present |
| `sku` | present | absent (`seller_sku`) | present | absent | present |
| `upc` / `upc_code` | `upc_code` | `upc_code` | absent | `upc` | absent |
| `parsed_asin` … `parsed_upc` | absent | absent | absent | absent | absent |
| `product_identifier` | absent | absent | present | absent | absent |

## Bridge-only (map)

| Column | product_identifier_map |
|--------|------------------------|
| `seller_sku` | present |
| `confidence_score` | present |
| `resolution_status` | present |
