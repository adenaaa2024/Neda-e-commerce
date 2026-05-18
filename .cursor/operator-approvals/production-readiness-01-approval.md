# Production Readiness 01 — Environment registration (ref + read-only access)

**Purpose:** Unblock production migration planning by registering the **production** Supabase project separately from dev/staging.

**Policy:** [single-supabase-project-policy.md](../environment-policy/single-supabase-project-policy.md) — **ACTIVE**. Production-readiness is **BLOCKED** until a second project exists.

## Environment distinction (required)

| Environment | Project ref | Status |
|-------------|-------------|--------|
| `CURRENT_SINGLE_SUPABASE_PROJECT` (sole live DB) | `kxsvedvpjldygtdbylsy` | **Only project** — not separate staging/production |
| **Production** | **NOT_CREATED_YET** | **BLOCKED** — must differ from `kxsvedvpjldygtdbylsy` |

Current project: `kxsvedvpjldygtdbylsy`  
Separate production project exists: **false**  
Separate staging project exists: **false**

Do not run production probe.  
Do not run production migrations.

## Operator provides (read-only — no apply in this approval)

```
PRODUCTION_PROJECT_REF=<20-char supabase ref>   # MUST NOT equal kxsvedvpjldygtdbylsy
PRODUCTION_SUPABASE_URL=https://<ref>.supabase.co
PRODUCTION_DIRECT_POSTGRES_URL=postgresql://...   # read-only role preferred
PRODUCTION_SERVICE_ROLE_KEY=                      # only if probe scripts require; prefer read-only DB user
```

**Security:** Do not commit secrets to git. Store in operator vault / `.env.local` (gitignored) only.

## Approval flags (this file)

| Flag | Meaning |
|------|---------|
| `APPROVED_TO_REGISTER_PRODUCTION_REF=true` | Ref + URLs recorded; distinct from single project |
| `APPROVED_TO_RUN_PRODUCTION_READ_ONLY_PROBE=true` | Authorize SELECT / information_schema probes only |

**Does NOT authorize:** DDL, DML writes, migration apply, RPC `CREATE OR REPLACE`, Amazon API, OpenAI/AI.

```
APPROVED_TO_REGISTER_PRODUCTION_REF=false
APPROVED_TO_RUN_PRODUCTION_READ_ONLY_PROBE=false
```

Production project ref: NOT_CREATED_YET  
Production direct Postgres URL configured in .env.local: false  
Confirmed production ref is NOT kxsvedvpjldygtdbylsy: false

## Signoff

**Status: BLOCKED** — prior signoff invalidated by NEXT-ENV-01 (single-project safety mode).

```
Environment: PRODUCTION ONLY
Status: BLOCKED
Supabase project ref/name: NOT_CREATED_YET
Production URL host matches ref: N/A
Read-only connection tested: N/A
Approved by: (pending — requires distinct production project)
Approved at UTC: (pending)
Notes: Sole live project is kxsvedvpjldygtdbylsy (CURRENT_SINGLE_SUPABASE_PROJECT).
        Do not run production probe. Do not run production migrations.
```
