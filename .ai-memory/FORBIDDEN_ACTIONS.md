# Forbidden actions — V176

**Hard stops for all agents.** If a user request conflicts, stop and confirm.

## Schema / data

| Action | Why forbidden |
|--------|----------------|
| Create or use **`package_items`** | Policy D-001; table must remain absent |
| Query **`.from("returns")`** | Legacy table; app uses **`return_items`** |
| **Auto-create products** from OCR/title/resolver | Governance V165/V175; breaks identifier authority |
| **Destructive migrations** without approval + rollback | Staging/production safety |
| **Production** DB prompts / migrations / resolver execute | `NOT_CREATED_YET` / **BLOCKED** |

## Environment

| Action | Why forbidden |
|--------|----------------|
| Set **`PRODUCTION_*`** to staging values | Would fake production cutover |
| Point **Vercel Production** at staging | Use Preview/local instead |
| Run **production probes** | Blocked until ref registered |

## Integrations

| Action | Why forbidden |
|--------|----------------|
| **Amazon SP-API** live calls | Unless user explicitly approves |
| **Live AI / OpenAI** | Unless AI governance approves |
| **Claim submission** / outbound filing | Unless operator filing approval |

## Resolver / bulk

| Action | Why forbidden |
|--------|----------------|
| Blind **V175 re-execute** when eligible=0 | Terminal for map path; fix upstream blockers |
| **Settlement bulk materialization** without wave approval | Governed waves only |
| Treat **`return_items`** staging rows as production truth | Test/fake data (6 rows) |

## Secrets

- Do not commit `.env.local`, bypass secrets, or service role keys.
- Do not commit `VERCEL_AUTOMATION_BYPASS_SECRET`.
