# Next step recommendation (NEXT-SCANNER-04)

## Immediate (operator) — unblock SCANNER-02C first

1. Create `.cursor/operator-approvals/scanner-02c-dev-staging-approval.md` with:
   - Correct **dev/staging** Supabase project ref (confirm whether `kxsvedvpjldygtdbylsy` is staging or production)
   - `environment: dev` or `staging`
   - `approved_by`, `approved_at`
   - `APPROVED_TO_APPLY_SCANNER_PRODUCT_LINKAGE_MIGRATION=true`
2. **Or** add `SUPABASE_ENV=development` (or `APP_ENV=staging`) to `.env.local` for the approved non-production project.
3. Re-run **SCANNER-02C** until `migration_applied: true` and live `information_schema` checks pass.

## Then re-run NEXT-SCANNER-04

```bash
npx tsx scripts/next-scanner-04-staging-e2e.ts
npx tsx scripts/next-scanner-04-staging-e2e.ts --write-test
```

Plus manual UI smoke (identification chips, returns drawer override).

## If `EP_TRACKING` still fails after migration

- Verify `expected_packages.asin` exists or remove `asin` from `EP_SELECT` if the column was never added.

## Exact next prompt (copy-paste)

```
SCANNER-02C — CONFIRM STAGING/DEV TARGET + APPLY SCANNER PRODUCT-LINKAGE MIGRATION + VERIFY SCHEMA

Prerequisite: `.cursor/operator-approvals/scanner-02c-dev-staging-approval.md` exists with APPROVED_TO_APPLY_SCANNER_PRODUCT_LINKAGE_MIGRATION=true (or SUPABASE_ENV/APP_ENV dev/staging in .env.local).

Apply supabase/migrations/20260717120000_scanner_product_linkage_columns.sql to the approved dev/staging project, run information_schema verification for expected_packages / return_items / slip_contents, record audit under .cursor/audit-reports/scanner-02c-confirm-staging-apply-verify/<new_run_id>/.
```

After a **passing** SCANNER-02C run:

```
NEXT-SCANNER-04 — STAGING E2E: EXTENDED SELECTS + DRAWER OVERRIDE + AUDIT LOG

Re-run on the same dev/staging Supabase target where migration was applied. Use scripts/next-scanner-04-staging-e2e.ts and --write-test; complete UI smoke; record under .cursor/audit-reports/next-scanner-04/<new_run_id>/.
```
