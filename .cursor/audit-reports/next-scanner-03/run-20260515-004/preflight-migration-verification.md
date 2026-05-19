# Preflight — migration verification

## SCANNER-02B status (authoritative for this workspace)

The latest 02b audit run **did not** mark the environment gate as passed: migration apply and live schema verification were **skipped** because dev/staging classification was not confirmed (`scanner-02b-apply-migration-dev-verify/run-20260515-003/blockers.md`, `validation-results.md`).

## Implication for NEXT-SCANNER-03

- Extended `SELECT` lists now reference columns from `20260717120000_scanner_product_linkage_columns.sql`. **PostgREST will error** on databases that have not applied that migration.
- Runtime behavior is therefore: **safe only after the migration is applied** to the target Supabase project, matching the NEXT-SCANNER-03 hard constraint (“do not run on DB without migration”).

## What was verified in-repo (no live DB)

- Migration file remains additive-only (unchanged review from NEXT-SCANNER-02 / 02b).
- `npx tsc --noEmit` passes on the branch after wiring.
- `npx tsx scripts/scanner-resolution-check.ts` passes (badge + aggregation sanity).

## Operator checklist before enabling in an environment

1. Apply `20260717120000_scanner_product_linkage_columns.sql` to that Supabase database.
2. Re-run 02b-style schema verification (`information_schema.columns` / PostgREST smoke) until the 02b gate is **Pass**.
3. Deploy app build that includes this NEXT-SCANNER-03 wiring.
