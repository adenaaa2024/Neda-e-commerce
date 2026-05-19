# Migration application report

## Migration file

- **Path:** `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql`
- **Status:** Present in repository; content reviewed — additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, indexes, conditional FKs, `NOTIFY pgrst`; no drops, no data delete, no `NOT NULL` on product ids.

## Application attempt

| Step | Outcome |
|------|---------|
| Preflight read of NEXT-SCANNER-02 audit | Completed |
| Environment confirmed dev/staging | **Failed — not confirmed** |
| `supabase db push` / `psql` apply against remote | **Not executed** |

## Conclusion

**Migration not applied** in this run. Applying against the default workspace `.env.local` target would require a confirmed non-production database; that confirmation was not available.

## When unblocked (operator checklist)

1. Point tooling at the **confirmed** staging (or dev) database connection (service role or migration runner).
2. Apply the single migration file above (e.g. Supabase Dashboard SQL, `supabase migration up` against linked staging, or CI staging pipeline).
3. Re-run `schema-verification.md` queries (or equivalent) and refresh this audit run.
