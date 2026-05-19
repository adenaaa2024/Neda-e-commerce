# Operator approval (SCANNER-02C)

## Status

**Not obtained** — migration apply blocked.

## Required file (not present)

Path: `.cursor/operator-approvals/scanner-02c-dev-staging-approval.md`

Expected contents:

- Supabase project name/ref
- `environment`: `dev` or `staging`
- `approved_by`
- `approved_at`
- Explicit line: `APPROVED_TO_APPLY_SCANNER_PRODUCT_LINKAGE_MIGRATION=true`

## Alternative env markers (not present)

None of the following were found in `.env.local` or the agent shell:

- `VERCEL_ENV=preview` / `development`
- `NODE_ENV=development`
- `APP_ENV=staging` / `development`
- `SUPABASE_ENV=staging` / `development`

## Operator action to unblock

Create the approval file (or add a documented dev/staging env marker to a non-production env file), then re-run **SCANNER-02C** or **SCANNER-02B** with the same migration path.
