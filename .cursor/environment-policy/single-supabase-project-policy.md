# Single Supabase Project — Operating Policy

> **Superseded for labeling** by [dual-project-staging-registration.md](dual-project-staging-registration.md) (2026-05-21).  
> **Superseded for labeling** — dual-project policy is canonical.  
> Original / rollback: `kxsvedvpjldygtdbylsy`. Staging clone / local app test: `eiqfaapyumhixxoeltgu` (ENV-05E).  
> Production: `NOT_CREATED_YET`.

**Policy ID:** `SINGLE-SUPABASE-PROJECT-01`  
**Effective:** 2026-05-18  
**Status:** SUPERSEDED — see dual-project policy; production-readiness **BLOCKED**

## Canonical project identity

| Constant | Value |
|----------|-------|
| `CURRENT_SINGLE_SUPABASE_PROJECT` | `kxsvedvpjldygtdbylsy` |
| Separate production project exists | **false** |
| Separate staging project exists | **true** (`eiqfaapyumhixxoeltgu`) |

There is **one** Supabase project. It is **not** split into staging vs production at the infrastructure layer. All agents and operators must treat `kxsvedvpjldygtdbylsy` as the sole live database unless and until a **distinct** production project is created and registered.

Do **not** label this ref as "production only" or "staging only" in approvals, probes, or migration plans without an explicit second project ref.

## Production-readiness gate

| Gate | Status |
|------|--------|
| Production ref registration | **BLOCKED** — no distinct production project |
| Production read-only probe | **BLOCKED** — do not run |
| Production migration apply | **BLOCKED** |
| Production DDL / DML writes | **BLOCKED** unless domain-specific operator approval + backup |

Approval source of truth: [production-readiness-01-approval.md](../operator-approvals/production-readiness-01-approval.md)

Required flags (must remain `false` until a second project exists):

```
APPROVED_TO_REGISTER_PRODUCTION_REF=false
APPROVED_TO_RUN_PRODUCTION_READ_ONLY_PROBE=false
```

## Hard prohibitions (always)

While this policy is active:

- **No production probe** — do not run `next-production-readiness-02-probe.ts` or any SELECT/information_schema probe framed as "production".
- **No production migrations** — no `supabase db push`, migration apply, or DDL against a labeled "production" target.
- **No treating the single ref as production** — env vars named `PRODUCTION_*` must not point at `kxsvedvpjldygtdbylsy`.

## Allowed work (small scoped dev)

Continued development is permitted when **all** of the following hold:

1. **Scope** — Local code, docs, tests, or read-only analysis; or governed staging work explicitly approved in a domain approval file.
2. **Operator approval** — Writes, smokes, or migration apply require the relevant `.cursor/operator-approvals/*` file with explicit flags (not production-readiness-01).
3. **Backup** — Before any approved DDL/DML on the single project, operator confirms backup or rollback path documented in the approval or run manifest.
4. **Labeling** — Run manifests and commits must state `target: CURRENT_SINGLE_SUPABASE_PROJECT` (ref above), not "production".

Examples of typically allowed activities:

- Application and script changes in the repo (no DB connection).
- Read-only SQL in audit reports (SELECT / `information_schema`) when not framed as production probe.
- Staging-governed smokes **only** when a domain approval file authorizes writes and operator accepts single-project risk.

## Unblocking production-readiness

Production-readiness work resumes only when:

1. Operator creates a **new** Supabase project (ref ≠ `kxsvedvpjldygtdbylsy`).
2. [production-readiness-01-approval.md](../operator-approvals/production-readiness-01-approval.md) records the new ref, sets register/probe flags per operator intent, and signoff confirms refs differ.
3. A new audit run supersedes [next-env-01](../audit-reports/next-env-01/) with `separate_production_project: true`.

Until then, **NEXT-PRODUCTION-READINESS-*** prompts remain blocked.

## Related artifacts

- Audit: [next-env-01](../audit-reports/next-env-01/)
- Prior readiness runs: `next-production-readiness-01`, `02`, `02b` (all blocked on ref separation)
