# Operator approval — Amazon initial live source sync (V1)

**Phase:** `PHASE-AMAZON-INITIAL-LIVE-SOURCE-SYNC-EXECUTE-V1`
**Target project:** `kxsvedvpjldygtdbylsy` (ORIGINAL / LIVE)
**Owner:** Maysam / operator
**Status:** BLOCKED — awaiting operator approval **and** env/worker-flag activation.

---

## What this approves

Running the **initial live SP-API / Reports API source sync** for claim/product/financial
sources against the LIVE project, through the existing import pipeline only. This is a
**source sync** — it does NOT create claim candidates, does NOT mark claims fileable, does
NOT submit anything to Amazon, and does NOT touch scanner data.

Sources in scope (request only for the configured rolling window, respect rate limits):

1. Settlement / Transaction Order rows — `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`
2. Reimbursements — `GET_FBA_REIMBURSEMENTS_DATA` / financial events
3. Removal Orders — `GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA`
4. Removal Shipments — `GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA`
5. FBA Customer Returns — `GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA`
6. Inventory Ledger — `GET_LEDGER_DETAIL_VIEW_DATA`
7. Fee Preview — `GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA`
8. Inbound Performance — `GET_FBA_FULFILLMENT_INBOUND_PERFORMANCE_DATA`
9. Finances archive (if available)

---

## Required token (set to `yes` to approve)

```
APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1=no
```

---

## Required environment / worker flags (must ALL be set before the sync can run)

The guarded executor refuses to run (and will not fake success) until the master worker
flag is enabled. Set the following in the deployment env (NOT `NEXT_PUBLIC_*`, never commit
secret values):

```
ENABLE_AMAZON_REPORTS_API_WORKER=true            # master switch (required)
ENABLE_AMAZON_REPORTS_API_SETTLEMENT=true        # source 1
ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS=true    # source 2
ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER=true     # source 3
ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT=true  # source 4
ENABLE_AMAZON_REPORTS_API_FBA_RETURNS=true       # source 5
ENABLE_AMAZON_REPORTS_API_INVENTORY_LEDGER=true  # source 6
ENABLE_AMAZON_REPORTS_API_FEE_PREVIEW=true       # source 7
ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE=true  # source 8
ENABLE_AMAZON_FINANCES_API_WORKER=true           # source 9 (finances archive)
ENABLE_AMAZON_FINANCES_API_INGEST=true           # source 9 ingest
CRON_SECRET=<secret>                             # required for worker/cron auth
```

(`AMAZON_SP_API_ENABLED=true` is already present — it powers the catalog/pricing
enrichment lane, NOT these Reports/Finances sync workers.)

---

## How to run after approval + env activation

1. Set `APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1=yes` above.
2. Set the env/worker flags above in the LIVE deployment env.
3. Re-run: `npx tsx scripts/phase-amazon-initial-live-source-sync-execute-v1.ts --execute`

The executor will then pull each approved source for the configured rolling window through
the existing pull-worker pipeline (request → poll → download → parse → normalize → import),
update source run status, and report rows imported + freshness — without creating claims.

---

## Hard rules (enforced)

- No claim submission / Amazon case API. No browser automation.
- No claim_candidate generation. No claim_candidates / claim_cases / claim_lines /
  claim_submissions mutation. No scanner code change. No AI as source of truth.
- Respect API rate limits; request only the configured rolling window.
- Store raw + normalized rows through the existing importer; update source run status.
- If a report permission is missing, record the blocker and continue other approved sources.
- Never print secrets.
