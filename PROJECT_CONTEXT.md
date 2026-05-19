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

## Shared memory

- **Session start:** [`.ai-memory/CURRENT_STATE.md`](.ai-memory/CURRENT_STATE.md)
- **Full timeline:** latest canonical path in [`.ai-memory/HISTORY_POINTERS.md`](.ai-memory/HISTORY_POINTERS.md)
- **Updates:** every memory change must update **append-only full history and `.ai-memory` together** in the same session (paired-update law). Also keep [TASKS.md](TASKS.md) aligned with [`.ai-memory/NEXT_ACTIONS.md`](.ai-memory/NEXT_ACTIONS.md).
