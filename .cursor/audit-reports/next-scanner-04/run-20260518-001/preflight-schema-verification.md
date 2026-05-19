# Preflight schema verification (NEXT-SCANNER-04)

## Prerequisites

| Gate | Result |
|------|--------|
| SCANNER-02C run `run-20260518-001` | **Fail** — migration not applied; live schema not verified in 02C |
| Operator approval `.cursor/operator-approvals/scanner-02c-dev-staging-approval.md` | **Missing** |
| Dev/staging env marker (`SUPABASE_ENV`, `APP_ENV`, etc.) | **Not set** in `.env.local` or shell |

Per prompt: **NEXT-SCANNER-04 did not proceed with write E2E** until SCANNER-02C passes.

## Live probe (read-only, service role)

Executed `npx tsx scripts/next-scanner-04-staging-e2e.ts` against project ref `kxsvedvpjldygtdbylsy` (from workspace `.env.local`).

| Table / check | Result | PostgREST detail |
|---------------|--------|------------------|
| `expected_packages` + linkage columns (`EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT`) | **Fail** | `42703: column expected_packages.identifier_resolution_status does not exist` |
| `return_items` + linkage columns (`RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT`) | **Fail** | `42703: column return_items.expected_item_id does not exist` |
| `products` readable | **Pass** | Head count OK |

**Conclusion:** `20260717120000_scanner_product_linkage_columns.sql` is **not applied** on the linked database.

## Static migration file check

Migration file `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql` remains present and additive-only (same static review as SCANNER-02C).

## SQL template (run after SCANNER-02C apply)

Use the `information_schema` queries in  
`.cursor/audit-reports/scanner-02c-confirm-staging-apply-verify/run-20260518-001/schema-verification.md`  
(expect 11 / 13 / 15 column rows).
