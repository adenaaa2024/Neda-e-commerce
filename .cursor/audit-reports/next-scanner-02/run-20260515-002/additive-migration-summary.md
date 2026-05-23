# Additive migration summary

## File

`supabase/migrations/20260717120000_scanner_product_linkage_columns.sql`

## Behavior

- **Additive only:** `ADD COLUMN IF NOT EXISTS`, indexes, optional FKs to `products` / `catalog_products` when those tables exist.
- **No** `DROP`, `TRUNCATE`, `NOT NULL` tightening, data delete, or table recreate.
- Ends with `NOTIFY pgrst, 'reload schema';` for PostgREST cache refresh (standard in this repo).

## Operator approval

Do **not** apply to production until an operator explicitly approves. Local/staging: `supabase db reset` or targeted `supabase migration up` per your runbook.

## Rollout note

Until the migration is applied:

- `insertReturn` enrichment and slip enrichment **catch** PostgREST errors and log warnings (no user-facing save failure solely for missing columns).
- Default `EP_DETAIL_SELECT` / `RETURN_LIST_SELECT` avoid new columns so existing environments keep working.
