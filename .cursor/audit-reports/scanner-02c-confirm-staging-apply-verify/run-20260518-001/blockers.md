# Blockers (SCANNER-02C)

## Active

1. **Environment not confirmed as dev/staging** — Workspace `.env.local` points at hosted Supabase project ref `kxsvedvpjldygtdbylsy` without an explicit dev/staging classification or operator approval file. Per SCANNER-02C, migration apply and live schema verification **must not** proceed.

2. **Operator approval missing** — Required file `.cursor/operator-approvals/scanner-02c-dev-staging-approval.md` does not exist (parent directory also missing).

## Impact

- `20260717120000_scanner_product_linkage_columns.sql` **not applied** on any database this run.
- Product linkage columns on the linked project remain **unverified**.
- Extended scanner/returns selects and enrichment PATCHes that reference new columns may **no-op or log PostgREST errors** until migration is applied on the correct target.

## Cleared (informational)

- Migration SQL is additive-only (static review).
- `tsc` and `npm run build` succeed on current branch.
- No legacy `.from("returns")` references in app/lib TypeScript.
