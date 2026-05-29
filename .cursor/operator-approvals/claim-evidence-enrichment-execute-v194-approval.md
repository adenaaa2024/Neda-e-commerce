# Claim evidence enrichment execute — V194 operator approval

**Scope:** Governed `claim_reference_edges` INSERT for FK-valid returns/removals draft cohort only (excludes `amazon_removal_shipments` until loader verified end-to-end).

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| `APPROVED_TO_RUN_STAGING` | `true` |
| `APPROVED_AT` | `2026-05-25T23:00:00Z` |
| V193 dry-run run | `20260525T220000Z` |
| Cohort | `amazon_returns` + `amazon_removals` drafts with valid `products` FK and zero persisted edges |
| Prerequisite | `.cursor/operator-approvals/claim-evidence-04-dev-staging-write-approval.md` (`APPROVED_TO_WRITE_CLAIM_EVIDENCE_04_DEV_STAGING=true`) |

## Tables (write scope)

- `claim_enrichment_generations`
- `claim_evidence_lineage_events`
- `claim_reference_edges`

## Forbidden

- Production writes
- `amazon_removal_shipments` cohort execute (loader extension only in V194)
- Claim submit / delete claim tables
- Amazon API / AI
- Product auto-create

## Execute script

`npx tsx scripts/claim-evidence-enrichment-execute-v194-staging.ts --run-id=<id> --execute --max-drafts=50`
