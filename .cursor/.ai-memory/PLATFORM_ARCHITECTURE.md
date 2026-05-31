# Platform architecture — Monorix ERP / WMS / PIM

**Repo:** `ecommerce-os`  
**Platform:** **Monorix** — multi-tenant Amazon-centric ERP, warehouse management (WMS), and PIM  
**Production domain:** `menorix.com` (Vercel Production → original Supabase ref)  
**Branch:** `feature/product-canonicalization-v2`  
**Last updated:** 2026-06-06 (`ai-memory-update` append)

> **Policy:** Indexes domain architecture. Validated V192, PC Phase 01, and phase1 rules live in linked modules — **append-only**; do not delete prior contracts.

## Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js App Router, Vercel |
| Data | Supabase PostgreSQL + Auth + Storage + RLS |
| Server | `lib/supabase-server.ts` — active env quartet only |
| Workers | GHA removal automation; `background_jobs` phase 1 (staging) |
| AI | Default deny — `lib/ai-provider-gates.ts` |

## Domain modules

| Domain | File |
|--------|------|
| Product canonicalization | [PRODUCT_CANONICALIZATION.md](PRODUCT_CANONICALIZATION.md) |
| **Product Core (protected)** | [PRODUCT_CORE_ARCHITECTURE.md](PRODUCT_CORE_ARCHITECTURE.md) |
| Identifier governance | [PRODUCT_IDENTIFIER_GOVERNANCE.md](PRODUCT_IDENTIFIER_GOVERNANCE.md) |
| Scanner (item-level) | [SCANNER_STATE.md](SCANNER_STATE.md) · [SCANNER_OPERATOR_CONTRACTS.md](SCANNER_OPERATOR_CONTRACTS.md) |
| Expected allocation | [EXPECTED_ALLOCATION_MODEL.md](EXPECTED_ALLOCATION_MODEL.md) |
| Removal ingestion | [REMOVAL_API_INTAKE.md](REMOVAL_API_INTAKE.md) · [REMOVAL_API_STATE.md](REMOVAL_API_STATE.md) |
| Claims | [CLAIM_ARCHITECTURE.md](CLAIM_ARCHITECTURE.md) · [CLAIMS_TRID_STATE.md](CLAIMS_TRID_STATE.md) |
| TRID | [CLAIMS_TRID_STATE.md](CLAIMS_TRID_STATE.md) |
| Inventory views | [SCANNER_OPERATOR_CONTRACTS.md](SCANNER_OPERATOR_CONTRACTS.md) |
| Undo / audit | [UNDO_AUDIT_ARCHITECTURE.md](UNDO_AUDIT_ARCHITECTURE.md) |
| Async jobs | [ASYNC_JOB_ARCHITECTURE.md](ASYNC_JOB_ARCHITECTURE.md) |
| Staging/original parity | [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) |
| Environment | [ENVIRONMENT_TOPOLOGY.md](ENVIRONMENT_TOPOLOGY.md) |

## Non-negotiable rules (carried forward)

| Rule | Status |
|------|--------|
| Product Resolution Contract V192 | **LOCKED** — `npm run check:product-resolution-contract-v192` |
| `package_items` | **FORBIDDEN** / absent |
| Legacy `returns` line reads | **FORBIDDEN** |
| Product create from title/OCR/fuzzy/UI | **FORBIDDEN** |
| Browser Supabase linkage writes | **FORBIDDEN** |
| `ProductLinkageDisplayContract` | Canonical UI/API display |
| Staging-first proofs | Required before original DML |
| Future Supabase production project | **NOT_CREATED_YET** (separate ref; cutover blocked) |

## DB topology

| Surface | Ref | Role |
|---------|-----|------|
| Staging | `eiqfaapyumhixxoeltgu` | Local, Preview, Neda, governed executes |
| Original / current | `kxsvedvpjldygtdbylsy` | **Vercel Production app DB** (`menorix.com`) |
| Future production | `NOT_CREATED_YET` | New project only — operator cutover charter |

## Session start

[CURRENT_STATE.md](CURRENT_STATE.md) → [ROADMAP.md](ROADMAP.md) → task domain module → [HISTORY_POINTERS.md](HISTORY_POINTERS.md)
