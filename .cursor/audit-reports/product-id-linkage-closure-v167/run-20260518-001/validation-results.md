# Validation results

**Audit:** product-id-linkage-closure-v167  
**Run:** run-20260518-001  
**Date:** 2026-05-18

## Automated probes

Command: `npx tsx scripts/product-id-linkage-closure-v167-probe.ts`

| Category | Pass | Fail | Notes |
|----------|------|------|-------|
| OpenAPI table inventory | 8 | 1 | `listing_raw_rows` not in OpenAPI |
| App SELECT probes | 8 | 5 | See below |
| Sample data queries | 3 | 0 | Read-only |

### App SELECT probe detail

| Probe | Result |
|-------|--------|
| `return_items_list_with_linkage` | PASS |
| `return_items_linkage_only` | PASS |
| `slip_contents_linkage` | PASS |
| `EP_SELECT_identify` | PASS |
| `EP_DETAIL_SELECT` | PASS |
| `packages_list` | PASS |
| `product_identifier_map_bridge` | PASS |
| `return_items_legacy_product_id` | PASS |
| `EP_TRACKING_with_scanner_product` | FAIL 42703 |
| `EP_DETAIL_with_scanner_product` | FAIL 42703 |
| `v_product_identity` | FAIL PGRST205 |
| `return_items_identifier_resolution_source` | FAIL 42703 |
| `slip_contents_identifier_resolution_source` | FAIL 42703 |
| `slip_contents_parsed_columns` | FAIL 42703 |

## Code review checks

| Check | Result |
|-------|--------|
| Scanner does not auto-create products | PASS |
| Scanner does not create `package_items` | PASS |
| `insertReturn` calls enrichment | PASS |
| Slip replace calls enrichment | PASS |
| No production / Amazon / OpenAI calls in audit | PASS |

## Overall verdict

**PARTIAL** — Bridge and catalog closed; scanner unit linkage wired but schema and staging data incomplete; expectation SKU model intentionally open for product FK until migration.
