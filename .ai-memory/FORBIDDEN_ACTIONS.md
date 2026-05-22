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
| Treat **`return_items`** (6 rows) as production truth | Test data |

## Secrets

- Do not commit `.env.local`, bypass secrets, service role keys, or AI API keys in repo.
