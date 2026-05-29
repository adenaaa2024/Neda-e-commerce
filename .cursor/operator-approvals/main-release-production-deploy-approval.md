# Main release — production deploy gate (operator approval)

**Status:** **APPROVED** — operator signed 2026-05-29T17:52:16Z (all four gate flags `true`).

| Field | Value |
|-------|--------|
| Source branch | `feature/product-canonicalization-v2` |
| Target branch | `main` |
| Feature HEAD (at approval) | `48c036d` |
| Main HEAD (at template creation) | `0e294a2` |
| Production domain | `app.monorix.com` |
| Production Supabase ref | `kxsvedvpjldygtdbylsy` |
| Preview/staging Supabase ref | `eiqfaapyumhixxoeltgu` |

## Release gate flags

```text
APPROVED_TO_MERGE_FEATURE_TO_MAIN=true
APPROVED_TO_ALLOW_PRODUCTION_DEPLOY=true
CONFIRMED_AGENT_LIVE_FILING_DISABLED=true
CONFIRMED_SCANNER_CLAIM_PROMOTE_SAFE=true
```

## Operator Vercel UI confirmations (manual)

Confirmed in **Vercel Dashboard** (values not recorded here):

### Project & deploy

- [x] Vercel project name: *(confirmed in dashboard; not recorded in file)*
- [x] **Production Branch** = `main` (confirm actual value): **main**
- [x] Merging/pushing to `main` **auto-deploys Production**: behavior **understood** by operator
- [x] Production custom domain includes `app.monorix.com`: **YES**
- [ ] Deploy freeze or ignored-build-step available if merge must not deploy: *(not attested)*

### Production environment — active quartet (values NOT recorded here)

- [x] `NEXT_PUBLIC_SUPABASE_URL` host ref = `kxsvedvpjldygtdbylsy` (original): **YES**
- [x] Production quartet does **not** point at `eiqfaapyumhixxoeltgu` (staging): **YES**
- [x] `STAGING_*` alias keys are **not** copied into Production active quartet: **YES** *(operator attestation)*

### Claim / agent / scanner flags (Production bucket)

Expected safe Production state:

| Variable | Expected on Production | Confirmed |
|----------|------------------------|-----------|
| `CLAIM_AGENT_ENABLED` | unset / `0` / absent | [x] |
| `CLAIM_AGENT_EXECUTE_BROWSER` | unset / `0` / absent | [x] |
| `CLAIM_PDF_API_ENABLED` | unset / `0` / absent | [x] |
| `CLAIM_SCANNER_AUTO_PROMOTE_ENABLED` | unset / `0` / absent | [x] |
| `CLAIM_SCANNER_AUTO_PROMOTE_ORIGINAL_APPROVED` | unset / `0` / absent | [x] |

Note: Python claim agent/PDF run on separate backend host if deployed — verify that host separately. Next.js Vercel Production does not auto-enable Python env vars.

### Cron / jobs / automation

| Surface | Expected | Confirmed |
|---------|----------|-----------|
| Vercel Cron (if any) on Production | none affecting live DB without approval | [ ] |
| GitHub Actions `removal-automation-staging.yml` | staging-only; dry-run by default | [ ] |
| `REMOVAL_AUTOMATION_APPLY_ENABLED` secret | `false` or unset unless explicit apply | [ ] |
| Async jobs API (`/api/jobs/*`) | staging-guarded in code; confirm not used on prod | [ ] |

### Preview / staging (for Neda — not Production)

- [x] Preview / feature branch uses staging ref `eiqfaapyumhixxoeltgu`: **YES**
- [x] `CLAIM_SCANNER_AUTO_PROMOTE_ENABLED=1` set **only** on Preview/staging scope (not Production): **YES**

## When flags may be set true

| Flag | Meaning |
|------|---------|
| `APPROVED_TO_MERGE_FEATURE_TO_MAIN=true` | Operator approves merging PR to `main` (code review complete; remaining blockers documented) |
| `APPROVED_TO_ALLOW_PRODUCTION_DEPLOY=true` | Operator accepts that merge may trigger Production deploy to original DB |
| `CONFIRMED_AGENT_LIVE_FILING_DISABLED=true` | Production + Python backend: no live Seller Central filing (`CLAIM_AGENT_*` off) |
| `CONFIRMED_SCANNER_CLAIM_PROMOTE_SAFE=true` | Production: `CLAIM_SCANNER_AUTO_PROMOTE_ENABLED` off (default guard); scanner save works without claim writes |

## Sign-off (operator only)

```text
APPROVED_TO_MERGE_FEATURE_TO_MAIN=true
APPROVED_TO_ALLOW_PRODUCTION_DEPLOY=true
CONFIRMED_AGENT_LIVE_FILING_DISABLED=true
CONFIRMED_SCANNER_CLAIM_PROMOTE_SAFE=true

Approved by: Maysam Ebrahimi
UTC date: 2026-05-29T17:52:16Z
Vercel project: (confirmed in dashboard; not recorded in file)
Production branch confirmed: main
Production domain: app.monorix.com
Production Supabase ref confirmed: kxsvedvpjldygtdbylsy
Preview/staging Supabase ref confirmed: eiqfaapyumhixxoeltgu
Auto-deploy on main merge confirmed: understood (operator attestation)
Feature HEAD at approval: 48c036d
PR URL:
Notes: Operator explicitly confirmed all production claim/agent/scanner flags are absent or 0/OFF. Scanner claim promote safe because production default is OFF and original ref requires explicit approval. Agent live filing disabled on Production.
```

## Related audits

- `.cursor/audit-reports/release-main-merge-readiness-census/20260602T210000Z/`
- `.cursor/audit-reports/scanner-claim-promote-production-guard/20260602T230000Z/`
- `.cursor/audit-reports/operator-vercel-production-deploy-gate/20260602T240000Z/`
- `.cursor/audit-reports/operator-confirmed-approval-flags-set-true/20260529T175216Z/`

## Forbidden without separate approval

- Setting `CLAIM_SCANNER_AUTO_PROMOTE_ORIGINAL_APPROVED=1` on Production
- Enabling `CLAIM_AGENT_EXECUTE_BROWSER=1` on any surface
- Production DB migrations or claim schema apply
