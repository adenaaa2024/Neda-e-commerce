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
| D-008 | V174 | **Staging `return_items` is test data** | 6 rows; do not treat coverage % as production truth. |
| D-009 | ENV-06 | **Preview must use staging ref** | Branch-scoped active quartet; protection separate from DB wiring. |
| D-010 | V175 | **Paired-update law** | Every memory update: append-only **full history + `.ai-memory` together** (same session); `TASKS.md` aligned; never one without the other. |
| D-011 | V193 | **Product input enrichment is backend-gated only** | Barcode blur/scan/paste/Enter may auto-lookup locally; Amazon/API enrichment must run only server-side on staging with explicit gates, never from browser or fake SP-API data. |
| D-012 | V198 | **E1B map-only requires active `products.id` FK** | Import-table `product_id` alone is insufficient; execute must prove trusted id exists on spine (`deleted_at IS NULL`, not merged) before `product_identifier_map` insert. |

When you make a new decision, add a row here and bump `CURRENT_STATE.md` if facts change.
