# Project context — ecommerce-os

## What this is

Multi-tenant **ERP/PIM** for Amazon-centric logistics: warehouse scanner, returns, claims (TRID), imports, and product identifier resolution. Primary builders: **Main/user** (architecture, resolvers, env) and **Neda** (returns/scanner UI, product linkage display).

## Business objects (high level)

| Domain | Primary tables / concepts |
|--------|---------------------------|
| **Catalog (PIM)** | `products`, `product_identifier_map` — canonical product spine |
| **Warehouse** | `packages`, `pallets`, `return_items`, `slip_contents` — no `package_items` |
| **Claims** | `claim_candidates`, `claim_candidate_drafts`, evidence/filing paths, TRID read path |
| **Imports** | `raw_report_uploads`, Amazon report tables, governed materialization waves |
| **History** | `audit_logs`, event-style status tracking |

## Environment reality (V176)

| Surface | Supabase ref | Notes |
|---------|--------------|-------|
| **Original** | `kxsvedvpjldygtdbylsy` | Live DB, Vercel Production today, clone/rollback source |
| **Staging** | `eiqfaapyumhixxoeltgu` | Local dev, smokes, Neda integration, **target Preview DB** |
| **Production (future)** | `NOT_CREATED_YET` | **BLOCKED** — separate project required |
| **Vercel Preview** | Staging-backed | Deployment Protection blocks unattended HTTP (401) until operator signoff or bypass |

## What is NOT production-ready

- **Production cutover** — blocked until operator registration + approval pack.
- **`return_items` on staging** — low row count; **fake/test data** — not final business truth.
- **Bulk claim/settlement linkage** — partial; governed resolver waves only.
- **Live Amazon SP-API / OpenAI** — off unless explicitly approved.

## Canonical contracts

- **UI/API product linkage:** `ProductLinkageDisplayContract` (`lib/product-linkage-display-contract.ts`)
- **Environment topology:** `.cursor/environment-policy/final-env-topology-v170.md` and [`.ai-memory/ENVIRONMENT_TOPOLOGY.md`](.ai-memory/ENVIRONMENT_TOPOLOGY.md)
- **Database expectations:** [`.ai-memory/DATABASE_CONTRACT.md`](.ai-memory/DATABASE_CONTRACT.md)

## Product Resolution Contract — Non-Negotiable

All product-aware entrypoints use the same backend contract:

`manual/UI/API/import input -> normalize identifiers -> resolver -> products + product_identifier_map -> persist resolved_product_id when deterministic -> hydrate ProductLinkageDisplayContract -> render the same contract everywhere.`

This covers manual add/edit, scanner save, package/pallet child items, item detail, expected packages, slip contents, imports, API ingestion, claim generation, and Neda UI surfaces.

Allowed:

- Approved server actions and governed resolver/import scripts.
- Resolver-on-save for identifier changes.
- `ProductLinkageDisplayContract` hydration for detail/read surfaces.
- Explicit unresolved/ambiguous/mismatch states.

Forbidden:

- Direct browser Supabase writes for product-aware rows.
- UI `products.insert` / `products.upsert`.
- `package_items`.
- Legacy `.from("returns")`.
- Raw product-aware detail reads without hydration.
- Title/OCR/fuzzy/AI auto-link or auto-create.

Static guard: `npm run check:product-resolution-contract-v192`.

## Shared memory

- **Session start:** [`.ai-memory/CURRENT_STATE.md`](.ai-memory/CURRENT_STATE.md) → [`.ai-memory/ROADMAP.md`](.ai-memory/ROADMAP.md)
- **Domain slices:** `PRODUCT_CANONICALIZATION`, `SCANNER_OPERATOR_CONTRACTS`, `CLAIMS_ENGINE_STATE`, `SP_API_STATE`, `PACKAGING_DIMENSIONS_STATE`, `STAGING_ORIGINAL_PARITY`, `MIGRATION_LEDGER`, `KNOWN_RISKS`
- **Full timeline:** [`.ai-memory/HISTORY_POINTERS.md`](.ai-memory/HISTORY_POINTERS.md) → `.cursor/history/ERP_PIM_FULL_APPEND_ONLY_HISTORY_MASTER.md`
- **Updates:** every memory change must update **append-only full history and `.ai-memory` together** in the same session (paired-update law). Also keep [TASKS.md](TASKS.md) aligned with [`.ai-memory/NEXT_ACTIONS.md`](.ai-memory/NEXT_ACTIONS.md).
