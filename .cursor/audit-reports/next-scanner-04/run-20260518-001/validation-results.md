# Validation results (NEXT-SCANNER-04)

| Check | Result | Notes |
|-------|--------|-------|
| SCANNER-02C prerequisite | **Fail (gate)** | `run-20260518-001` — migration not applied |
| Operator approval / staging env | **Fail (gate)** | Approval missing; no env marker |
| Live schema (linkage columns) | **Fail** | PostgREST `42703` on `expected_packages`, `return_items` |
| `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` | **Fail** | Column missing on linked DB |
| `EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT` | **Fail** | Column missing (and possible `asin` base-column issue) |
| `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` | **Fail** | `expected_item_id` missing |
| `manualOverrideReturnItemProductResolution` live | **Skipped** | Gate + schema |
| `return_audit_log` after override | **Skipped** | Gate + schema |
| UI mismatch / unresolved / drawer | **Skipped (live)** | Static review pass |
| Scanner save when unresolved | **Skipped (live)** | Static review pass |
| No product create/merge | **Skipped (live)** | Static review pass |
| `npx tsc --noEmit` | **Pass** | Exit 0 |
| `npm run build` | **Pass** | Next.js 16.1.7 |
| `npx tsx scripts/scanner-resolution-check.ts` | **Pass** | Badge + aggregation checks |
| `npx tsx scripts/next-scanner-04-staging-e2e.ts` | **Exit 1** | Gate closed; all three extended selects fail |

## Tooling added

- `scripts/next-scanner-04-staging-e2e.ts` — read-only select probes; optional `--write-test` after gate opens.
