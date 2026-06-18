# Decisions log — V176 memory pack

Append-only policy decisions. Full program history: [HISTORY_POINTERS.md](HISTORY_POINTERS.md).

| ID | Date | Decision | Rationale |
|----|------|----------|-----------|
| D-001 | V163+ | **`package_items` forbidden** | Schema/policy: packages link via reconciled model; table must stay absent. |
| D-002 | V174 | **`return_items` replaces `returns` in app code** | Scanner/returns operable lane; legacy `returns` not queried. |
| D-003 | V169 | **`ProductLinkageDisplayContract` is canonical UI/API** | One mapper for Neda, scanner, claims, imports. |
| D-004 | V170 | **Four-environment topology** | Original = prod DB today; staging = integration; production project TBD. |
| D-005 | V165 | **No resolver/OCR product auto-create** | Barcode cache insert gated separately; resolver tiers never create products. |
| D-006 | V175 | **Claim resolver: deterministic tiers only** | Materialize `resolved_product_id` from source + `product_identifier_map`; no title linking. |
| D-007 | V176 | **Orphan FK remap execute for drafts** | `amazon_removal_shipments` RPIDs not in `products` — remap via map, 2179 applied. |
| D-008 | V174 | **Staging `return_items` is test data** | **SUPERSEDED 2026-05-31** — staging has 5,366 active RIs; ~5,333 bulk orphans; ~3 proven scans; do not use RI counts as production truth. |
| D-009 | ENV-06 | **Preview must use staging ref** | Branch-scoped active quartet; protection separate from DB wiring. |
| D-010 | V175 | **Paired-update law** | Every memory update: append-only **full history + `.ai-memory` together** (same session); `TASKS.md` aligned; never one without the other. |
| D-011 | V193 | **Product input enrichment is backend-gated only** | Barcode blur/scan/paste/Enter may auto-lookup locally; Amazon/API enrichment must run only server-side on staging with explicit gates, never from browser or fake SP-API data. |
| D-012 | V198 | **E1B map-only requires active `products.id` FK** | Import-table `product_id` alone is insufficient; execute must prove trusted id exists on spine (`deleted_at IS NULL`, not merged) before `product_identifier_map` insert. |
| D-013 | 2026-05-31 | **`return_items` = physical scans only** | Supersedes bad assumption that RI could denormalize expected forecast; evidence `full-scanner-expected-returns-claims-architecture-readonly/20260531T084101Z`. |
| D-014 | 2026-05-31 | **Forecast in `expected_packages`, not bulk RI** | API/removal/import lines stay on EP + allocation children; never bulk-create RI from forecast. |
| D-015 | 2026-05-31 | **No EP→RI linkage copy without physical scan proof** | Wave2 rollback PASS; field-only revert; ~5,333 orphan RIs still require quarantine. |
| D-016 | 2026-05-31 | **Scanner/return/claims DB gate** | Before any DB write/backfill/migration in this domain: read-only architecture audit + explicit operator approval file. |
| D-017 | 2026-05-31 | **Claims queue unsafe until physical-anchor gate** | `listReturnsClaimsWorkQueue` must require `package_id` before production use; auto-promote stays off. |
| D-018 | 2026-06-18 | **Removal-family Seller Central amount basis = `latest_sale_net`** | Maysam policy fix (`PHASE-CLAIM-AMOUNT-BASIS-LATEST-SALE-NET-POLICY-FIX-V1`): for `removal_shipment_missing` + `removal_order_discrepancy` the expected Amazon reimbursement = `(latest_sold_price − amazon_fees) × qty`. COGS / purchase cost / settlement net are **internal cost / profit-loss context only**, never the requested amount; sale price alone and settlement net alone are forbidden as the basis. When the policy amount is unknown (no loaded sale price) expected/open is UNKNOWN, never a COGS fallback. Stored in `workspace_settings.module_configs.claims.amount_basis_policy`. Supersedes the interim `cogs_recovery` basis from D-? (PHASE-CLAIM-AMOUNT-BASIS-POLICY-OPERATOR-CONFIRMATION-V1) for these two families. |

When you make a new decision, add a row here and bump `CURRENT_STATE.md` if facts change.
