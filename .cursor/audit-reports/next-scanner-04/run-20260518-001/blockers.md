# Blockers (NEXT-SCANNER-04)

## Active

1. **SCANNER-02C did not pass** — See `.cursor/audit-reports/scanner-02c-confirm-staging-apply-verify/run-20260518-001/`. Migration `20260717120000_scanner_product_linkage_columns.sql` was not applied; live schema verification was skipped.

2. **Environment gate** — No `.cursor/operator-approvals/scanner-02c-dev-staging-approval.md` and no `SUPABASE_ENV` / `APP_ENV` dev|staging marker. NEXT-SCANNER-04 write E2E and manual override tests were not executed per prompt.

3. **Linkage columns missing on linked Supabase** — Read-only probe confirms PostgREST errors for scanner product columns on `expected_packages` and `return_items`. Extended selects cannot succeed until migration is applied on the **approved** dev/staging project.

## Secondary (investigate after migration)

4. **`EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT` base `asin`** — Tracking select includes `asin` in `EP_SELECT`; linked DB may not expose `asin` on `expected_packages`. Re-probe after migration; fix select or schema if still failing.

## Cleared (informational)

- TypeScript and production build pass on current branch.
- UI and server-action contracts for override, badges, and audit log are implemented (NEXT-SCANNER-03).
- `scripts/scanner-resolution-check.ts` passes.

## Impact

- Staging E2E for extended selects, drawer override, and audit log: **not completed**.
- Production risk if extended selects deploy before migration: **unchanged** (PostgREST 400/42703).
