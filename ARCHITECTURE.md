# Architecture — ecommerce-os (V176)

## Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | Next.js App Router (React), Vercel deploy |
| **Backend / DB** | Supabase (PostgreSQL + Auth + Storage) |
| **Server data access** | `lib/supabase-server.ts` — active env quartet only |
| **Planned AI bridge** | Python FastAPI for SP-API (not live in production path) |

## Paradigm

- **Multi-tenant** with RLS on operational tables.
- **Strict product linkage:** identifiers (`asin`, `fnsku`, `sku`, etc.) resolve to `products.id` via `product_identifier_map` — not ad-hoc title/OCR product creation.
- **Event-style auditing** on status changes (`audit_logs`, claim history where applicable).

## Data model (authoritative V176)

### Catalog spine

- `products` — canonical `id`, display names, org scope (~17k on staging Sam).
- `product_identifier_map` — bridge for resolver tiers; legacy `product_id` on map rows only.

### Warehouse / returns

- **`return_items`** — line-level returns/scanner rows (replaces legacy **`returns`** table for app code).
- **`packages` / `pallets`** — parent hierarchy; schema uses `package_code`, `pallet_photo_urls` (V173 reconcile).
- **`package_items`** — **FORBIDDEN and absent** — do not create or query.

### Claims

- `claim_candidates`, `claim_candidate_drafts` — `resolved_product_id` materialized by governed resolver scripts (V175/V176).
- TRID read path finalized for inbox/evidence UI (V171+); filing/submit still gated.

### Imports / landing

- `raw_report_uploads` + Amazon report tables with `raw_data` JSONB where needed for flexible ingestion.
- Bulk settlement/ledger linkage — **governed waves only**; low % without explicit approval.

## Product linkage (UI)

**`ProductLinkageDisplayContract`** is the single display contract for Neda returns, scanner, claims, and imports:

- File: `lib/product-linkage-display-contract.ts`
- Mapper: `mapRowToProductLinkageDisplayContract`
- Enrichment: `lib/product-linkage-display-enrich.ts`

Use `resolved_product_id` + `identifier_resolution_status` — not legacy `product_id` alone.

## Deployment topology

```
Local dev          → staging ref (eiqfa…)
Vercel Preview     → staging ref (target; env PASS, HTTP may 401)
Vercel Production  → original ref (kxsved…) until future cutover
Future production  → NOT_CREATED_YET (blocked)
```

See [`.ai-memory/ENVIRONMENT_TOPOLOGY.md`](.ai-memory/ENVIRONMENT_TOPOLOGY.md) for variable names and operator rules.

## Module status (summary)

| Module | Status |
|--------|--------|
| Warehouse scanner + linkage UI | Operable on staging; Neda wiring PASS |
| PIM / store context | PASS (Sam AM ~17,001 products) |
| Claim engine / evidence | TRID read PASS; resolver coverage partial |
| Schema + build smoke | PASS (V175 combined) |
| Python SP-API agent | Planned — not production-live |
| Production cutover | BLOCKED |

## History policy

Long-form program history: `.cursor/audit-reports/history-canonical-rebuild-v182/20260518T120000Z/ERP_PIM_FULL_HISTORY_V182_CANONICAL_APPEND_ONLY_REBUILT.md` (V182 rebuild; base V175 from git `feab1b0`). Do not duplicate full history here — use [`.ai-memory/HISTORY_POINTERS.md`](.ai-memory/HISTORY_POINTERS.md).
