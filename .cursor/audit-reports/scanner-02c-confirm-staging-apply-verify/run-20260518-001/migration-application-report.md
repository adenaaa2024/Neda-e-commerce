# Migration application report (SCANNER-02C)

## Migration

- **Path:** `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql`
- **Type:** Additive nullable columns, indexes, optional FKs; `NOTIFY pgrst, 'reload schema'`
- **Static review:** Matches SCANNER-02C constraints (no drops, no NOT NULL on `product_id`, no data deletion)

## Application status

| Field | Value |
|-------|-------|
| **Applied** | **No** |
| **Blocked** | **Yes** |
| **Reason** | `environment_not_confirmed_dev_staging` |

## What would have been applied

Tables touched: `expected_packages`, `return_items`, `slip_contents` — see `schema-verification.md` for column checklist.

## How to apply after unblock

On a **confirmed** dev/staging Supabase project only:

1. Link CLI or use Supabase SQL editor / `psql` with service role on that project.
2. Run the migration file contents once (idempotent `ADD COLUMN IF NOT EXISTS`).
3. Re-run SCANNER-02C schema verification queries.
4. Record a new audit run with `migration_applied: true`.

**Do not** apply via this workspace `.env.local` until that file’s target is explicitly classified as dev/staging.
