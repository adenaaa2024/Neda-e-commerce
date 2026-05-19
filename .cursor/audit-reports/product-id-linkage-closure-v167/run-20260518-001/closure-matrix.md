# Product ID linkage closure matrix

**Run:** `run-20260518-001` | **Project:** `kxsvedvpjldygtdbylsy` | **Overall:** **PARTIAL**

Legend: ✅ Closed | ⚠️ Partial | ❌ Open | ➖ N/A (by design)

| # | Domain | Surface | DB schema | App write | App read / UI | Data on staging | Closure |
|---|--------|---------|-----------|-----------|---------------|-----------------|---------|
| 1 | Catalog | `products` | ✅ identifiers + PK | ➖ | ✅ imports, resolver | ✅ | ✅ |
| 2 | Bridge | `product_identifier_map` | ✅ `product_id` + tokens | ✅ imports | ✅ resolver | ✅ | ✅ |
| 3 | Scanner units | `return_items.resolved_product_id` | ⚠️ 4/13 cols | ✅ enrichment | ✅ `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` | ⚠️ sparse | ⚠️ |
| 4 | Scanner units | `return_items.product_id` (legacy) | ✅ column | ➖ not auto-set | ✅ selectable | null common | ⚠️ legacy unused |
| 5 | Scanner units | `identifier_resolution_source` | ❌ | ✅ attempted | ⚠️ UI optional | ❌ | ❌ |
| 6 | BOX lines | `slip_contents` linkage | ⚠️ 4/15 cols | ✅ enrichment | ✅ operator select | ❌ no resolved rows in sample | ⚠️ |
| 7 | Expectations | `expected_packages` product FK | ➖ absent | ➖ SKU/FNSKU only | ✅ `EP_SELECT` fallback | ➖ | ✅ by design |
| 8 | Containers | `packages` | ➖ no product FK | ➖ | ✅ list cols | ➖ | ✅ |
| 9 | Claims graph | `claim_reference_edges` | ➖ indirect refs | ➖ | ➖ join-time | ➖ | ✅ |
| 10 | Imports | `raw_report_uploads` | ➖ metadata | ✅ pipeline | ✅ admin UI | ✅ | ✅ |
| 11 | Listings | `catalog_products.product_id` | ✅ | ✅ import sync | ✅ | ✅ | ✅ |
| 12 | Read model | `v_product_identity` | ❌ not deployed | ➖ | ❌ REST | ❌ | ❌ |
| 13 | Returns admin | Manual `resolved_product_id` | ⚠️ | ✅ `_components.tsx` | ✅ | — | ⚠️ |
| 14 | Operator mobile | Manual override action | ⚠️ | ✅ `item-actions.ts` | ✅ scan page | source col missing | ⚠️ |
| 15 | Types | `database.types.ts` | — | — | ⚠️ ahead of DB | — | ⚠️ |
| 16 | Migration | `20260717120000` full apply | ❌ | — | — | — | ❌ |

## Closure by user story

| User story | Status | Blocker |
|------------|--------|---------|
| Operator scans item → canonical product on line | ⚠️ | Needs map hit + full patch columns; smoke row unresolved |
| Operator sees product badge on return list | ⚠️ | Works when `resolved_product_id` populated |
| Expectation lines tied to `products.id` | ❌ | Requires EP migration columns |
| Slip OCR tokens stored in DB | ❌ | `parsed_*` / OCR cols missing |
| Cross-report identity view | ❌ | `v_product_identity` not on staging |
| Import populates bridge for resolver | ✅ | Independent of scanner migration |

## Sign-off criteria (for ✅ full closure)

1. Operator-approved apply of `20260717120000` on staging (then production).
2. Re-probe: all `app_select_probes` in `probe-output.json` **PASS**.
3. Staging smoke: at least one `return_items` and one `slip_contents` row with non-null `resolved_product_id` after scan with known FNSKU in map.
4. Optional: deploy `v_product_identity` if consumers need unified read API.
