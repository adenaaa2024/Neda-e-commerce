# Environment topology — V176

Canonical policy: `.cursor/environment-policy/final-env-topology-v170.md`

## Projects

| Surface | Supabase ref | Role |
|---------|--------------|------|
| **Original** | `kxsvedvpjldygtdbylsy` | Live DB, clone source, rollback, **current Vercel Production** |
| **Staging** | `eiqfaapyumhixxoeltgu` | Local dev, Neda, smokes, **target Vercel Preview DB** |
| **Production (future)** | `NOT_CREATED_YET` | **BLOCKED** — must be new ref ≠ original ≠ staging |

Constants:

```
ORIGINAL_PROJECT_REF=kxsvedvpjldygtdbylsy
STAGING_PROJECT_REF=eiqfaapyumhixxoeltgu
PRODUCTION_PROJECT_REF=   # empty until registered
```

## App targets (current)

| Surface | DB ref | Status |
|---------|--------|--------|
| Local `npm run dev` | `eiqfaapyumhixxoeltgu` | Active quartet → staging (ENV-05E) |
| Vercel Preview (integration branch) | `eiqfaapyumhixxoeltgu` | Env wiring **PASS** |
| Vercel Production | `kxsvedvpjldygtdbylsy` | **Unchanged** |
| Future production | — | **BLOCKED** |

## Preview HTTP

- Preview is **staging-backed** for Supabase.
- **Deployment Protection** returns **401** for unauthenticated automated probes.
- Staging proxy / env proofs **PASS**; operator signoff or `VERCEL_AUTOMATION_BYPASS_SECRET` required for full HTTP smoke.

Example Preview URL (from ENV-06C audit):  
`https://ecommerce-os-git-integrat-ec746a-mebrahimipargoo-9799s-projects.vercel.app`

## Storage

- Staging storage clone: **144/144** objects PASS (including 8 large `raw-reports` retry).

## Rules

1. Never set `PRODUCTION_*` to staging credentials.
2. Never point Vercel Production at staging for testing.
3. Future cutover needs operator approval pack + audit signoff.
