# Forbidden actions — V178

**Hard stops for all agents (including Neda).** If a user request conflicts, stop and confirm.

## Schema / data

| Action | Why forbidden |
|--------|----------------|
| Create or use **`package_items`** | Policy; table must remain absent |
| Query **`.from("returns")`** | Legacy; use **`return_items`** |
| **Auto-create products** from OCR/title/resolver/UI | Governance V165/V175/V178 |
| **Destructive migrations** without approval + rollback | Safety |
| **Production** DB / migrations / resolver execute | `NOT_CREATED_YET` / **BLOCKED** |

## Neda / UI (V178)

| Action | Why forbidden |
|--------|----------------|
| **Direct-write browser Supabase** for linkage, resolver columns, or catalog | Use **approved server actions** only (`product-linkage-display-actions.ts`, existing returns server actions) |
| **Infer product** from title/OCR/SKU in UI when contract says unresolved | Use safe labels: “No product link yet”, “Needs review” |
| **Hide** unresolved/ambiguous/mismatch linkage states | Must display safely per V178 connector |
| Ad-hoc linkage DTOs bypassing `ProductLinkageDisplayContract` | Contract is canonical |

## AI (default deny)

| Action | Why forbidden |
|--------|----------------|
| **Live AI / OpenAI** without gates | `lib/ai-provider-gates.ts` — **default deny** |
| Enable **`AI_EXTERNAL_HTTP_ENABLED`** or per-surface flags | Operator + governance only |
| Assistant UI / OCR provider / autonomous loops in prod | Not enabled |

Requires explicit env: `AI_EXTERNAL_HTTP_ENABLED` + surface flags (e.g. `AI_IMPORT_GPT_FALLBACK_ENABLED`).

## Environment

| Action | Why forbidden |
|--------|----------------|
| Set **`PRODUCTION_*`** to staging | Fake cutover |
| Point **Vercel Production** at staging | Use Preview/local |
| **Production probes** | Blocked until ref registered |

## Integrations

| Action | Why forbidden |
|--------|----------------|
| **Amazon SP-API** live calls | Unless explicitly approved |
| **Claim submission** / outbound filing | Unless operator approval |

## Resolver / bulk

| Action | Why forbidden |
|--------|----------------|
| Blind **V175/V176 re-execute** when terminal / no signoff | Upstream fixes only |
| **Settlement / ledger blind bulk** | Governed waves only |
| Treat **`return_items`** (6 rows) as production truth | Test data — **SUPERSEDED**: staging active RI **33** after hard-delete; **3** proven physical scans; `bulk_orphan` **0** |
| **Bulk INSERT `return_items`** from expected_packages / API / removal | Architecture violation — forecast belongs in EP only |
| **EP → RI bulk `resolved_product_id` copy** without proven physical scan | Wave2 pattern — reverted; forbidden going forward |
| **Re-create bulk/orphan `return_items`** from expected/API/removal | Hard-delete repair complete — do not reintroduce |
| **Scanner/expected/return/claims DB write** without architecture audit + approval | Requires read-only evidence + `.cursor/operator-approvals/` file first |
| **Merge to main** | **NO** — commit repair state to feature branch only until operator approves |
| **Returns claims work queue** as production-safe | **UNSAFE** until `package_id` physical-anchor gate patched |
| Enable **`CLAIM_SCANNER_AUTO_PROMOTE_ENABLED`** | Remains **off** until cutoff configured + physical-anchor gate + orphan cleanup |

## Product Core (protected — 2026-06-13)

| Action | Why forbidden |
|--------|----------------|
| **Rewrite, simplify, bypass, or replace** Product Core flows | Protected backbone architecture |
| Change **matching, merge, resolver, product creation, normalization, or identifier-map writes** without gate | Requires read-only audit + parity proof + risk report + operator approval |
| **Broad product sheet import** | Dry-run: **1700** blocked creates; **3399** conflicts |
| **Redesign Product Core resolver** | Protected backbone — audit gate required |
| **Auto-create products** except governed seed approvals | Governance V165/V175/V178 |
| **Touch UniversalImporter file pipeline** | File-import path locked on Imports |
| **Drive Automation scope from global top selector** | Automation uses in-page company/store selectors only |
| **Re-add API panels to Data Management → Imports** | Cut over to Automation API Center |

Scope: `products`, `product_identifier_map`, `catalog_products`, resolver rules, PIM/sheet import, API enrichment, brand/category/vendor/dimensions/packaging/spec normalization, safe creation rules, raw/provenance preservation.

See [PRODUCT_CORE_ARCHITECTURE.md](PRODUCT_CORE_ARCHITECTURE.md).

## Secrets

- Do not commit `.env.local`, bypass secrets, service role keys, or AI API keys in repo.
