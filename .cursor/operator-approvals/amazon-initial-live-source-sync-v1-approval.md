# Amazon Initial Live Source Sync Approval V1

Status: APPROVED

APPROVED_AMAZON_INITIAL_LIVE_SOURCE_SYNC_V1=yes

Approved by: Maysam Ebrahimi

Approved at: 2026-06-22

Runtime target:
ORIGINAL/LIVE Supabase project kxsvedvpjldygtdbylsy

Scope:
- Run initial Amazon SP-API Reports/Finances live source sync.
- Do not submit claims.
- Do not create claim candidates.
- Do not mutate claim_candidates, claim_cases, claim_lines, claim_submissions.
- Do not change scanner code.
- Do not use browser automation.
- Store raw and normalized report rows only through existing guarded sync pipeline.

Required env confirmed by operator:
- ENABLE_AMAZON_REPORTS_API_WORKER=true
- ENABLE_AMAZON_REPORTS_API_SETTLEMENT=true
- ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS=true
- ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER=true
- ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT=true
- ENABLE_AMAZON_REPORTS_API_FBA_RETURNS=true
- ENABLE_AMAZON_REPORTS_API_INVENTORY_LEDGER=true
- ENABLE_AMAZON_REPORTS_API_FEE_PREVIEW=true
- ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE=true
- ENABLE_AMAZON_FINANCES_API_WORKER=true
- ENABLE_AMAZON_FINANCES_API_INGEST=true
- CRON_SECRET is set in local/deployment env