# Next step recommendation (SCANNER-02C)

## Immediate (operator)

1. Create `.cursor/operator-approvals/scanner-02c-dev-staging-approval.md` with:
   - Supabase project ref `kxsvedvpjldygtdbylsy` (or the correct **dev/staging** ref if different from `.env.local`)
   - `environment: dev` or `staging`
   - `approved_by`, `approved_at`
   - `APPROVED_TO_APPLY_SCANNER_PRODUCT_LINKAGE_MIGRATION=true`
2. **Or** point `.env.local` at a documented dev/staging project and add e.g. `SUPABASE_ENV=development` or `APP_ENV=staging`.
3. Re-run **SCANNER-02C** (same prompt) to apply migration and execute live schema verification.

## After gate passes

1. Apply `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql` on that project only.
2. Run SQL in `schema-verification.md`; expect 11 / 13 / 15 rows.
3. Optional: `npx tsx scripts/scanner-resolution-check.ts` and a manual scanner smoke on dev/staging.

## Then (engineering)

Proceed with **NEXT-SCANNER-03** extended-select wiring and review UI only after a **passing** SCANNER-02C run records `migration_applied: true` and live schema **pass**.

## Exact next prompt (copy-paste)

```
SCANNER-02C — CONFIRM STAGING/DEV TARGET + APPLY SCANNER PRODUCT-LINKAGE MIGRATION + VERIFY SCHEMA

Prerequisite: `.cursor/operator-approvals/scanner-02c-dev-staging-approval.md` exists with APPROVED_TO_APPLY_SCANNER_PRODUCT_LINKAGE_MIGRATION=true (or SUPABASE_ENV/APP_ENV dev/staging in .env.local).

Apply supabase/migrations/20260717120000_scanner_product_linkage_columns.sql to the approved dev/staging project, run information_schema verification for expected_packages / return_items / slip_contents, record audit under .cursor/audit-reports/scanner-02c-confirm-staging-apply-verify/<new_run_id>/.
```
