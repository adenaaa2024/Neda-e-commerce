# Amazon initial live source sync — operator setup

**Phase:** `PHASE-AMAZON-INITIAL-LIVE-SOURCE-SYNC-EXECUTE-V1`
**Readiness fix:** `PHASE-AMAZON-LIVE-SYNC-ENV-FLAG-READINESS-FIX-V2`
**Target project:** `kxsvedvpjldygtdbylsy` (ORIGINAL / LIVE)

This is the operator runbook for safely enabling the **initial live SP-API / Reports /
Finances source sync**. It does NOT call Amazon, generate claim candidates, mutate claims,
or touch scanner code. The sync only runs after BOTH gates below pass.

---

## Where readiness is shown in the UI

- **Control plane / Settings:** `/platform/settings/data-sources` — single source of truth.
  Shows per-source status badges, the **Initial live-sync readiness** banner
  (env complete / blocked), worker-flag column, missing-env blockers, SP-API credential
  presence, and the operator-approval requirement.
- **Claim Center / Sources, Data Coverage, Ready-to-File:** read the same hub
  (`composeDataSourcesHubStatusV1`), so the disabled/needs-env reasons are consistent.

---

## Two gates (both must pass)

### Gate 1 — Operator approval (process gate, not an env var)

Set the token in
`.cursor/operator-approvals/amazon-initial-live-source-sync-v1-approval.md`:

```
APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1=yes
```

Default is `no` (blocked). The executor refuses to run while it is `no` or the file is
absent, and never fakes success.

### Gate 2 — Worker env flags + cron secret

Set these in the **deployment env (Vercel)** — never in `NEXT_PUBLIC_*`, never commit secret
values. Accepted truthy values: `1` | `true` | `yes`. See `.env.example` for the full key
list. The master flag is required first; each per-source flag also requires the master flag.

```
ENABLE_AMAZON_REPORTS_API_WORKER=true            # master switch (required first)
ENABLE_AMAZON_REPORTS_API_SETTLEMENT=true        # settlement / transaction Order
ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS=true    # reimbursements
ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER=true     # removal orders
ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT=true  # removal shipments
ENABLE_AMAZON_REPORTS_API_FBA_RETURNS=true       # FBA customer returns
ENABLE_AMAZON_REPORTS_API_INVENTORY_LEDGER=true  # inventory ledger
ENABLE_AMAZON_REPORTS_API_FEE_PREVIEW=true       # fee preview
ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE=true # inbound performance
ENABLE_AMAZON_FINANCES_API_WORKER=true           # finances archive worker
ENABLE_AMAZON_FINANCES_API_INGEST=true           # finances archive ingest
CRON_SECRET=<secret>                             # required for worker/cron auth
```

Optional, only if the nightly cron route is used:

```
ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON=true
```

`AMAZON_SP_API_ENABLED=true` is already set — it powers the catalog/pricing enrichment lane,
NOT these Reports/Finances sync workers.

---

## SP-API credentials (already present — no action needed)

Seller credentials live in the DB (`marketplaces.credentials`), not in env. As of the V2
readiness check, all of the following are present for the target org (presence only — values
are never read or printed): LWA client id, LWA client secret, refresh token, AWS access key,
AWS secret key, marketplace id, region.

---

## Exact steps to enable the sync

1. Set `APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1=yes` in the approval file (Gate 1).
2. Set the 11 worker flags + `CRON_SECRET` in the LIVE deployment env (Gate 2).
3. Confirm `/platform/settings/data-sources` shows **Initial live-sync readiness: READY**.
4. Run: `npx tsx scripts/phase-amazon-initial-live-source-sync-execute-v1.ts --execute`.
5. The executor pulls each approved source for the configured rolling window through the
   existing pull-worker pipeline and reports rows imported + freshness — without creating
   claims.

---

## Hard rules (enforced)

- No claim submission / Amazon case API. No browser automation.
- No claim_candidate generation. No mutation of claim_candidates / claim_cases / claim_lines /
  claim_submissions. No scanner code change. No AI as source of truth.
- Respect API rate limits; request only the configured rolling window.
- Never print or commit secret values.
