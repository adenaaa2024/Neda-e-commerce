# Blockers

## Active (this run)

1. **Environment not confirmed as dev/staging** — Workspace `.env.local` points at a hosted Supabase URL without an explicit staging/dev classification variable or separate documented staging project. Per SCANNER-02B, the migration **must not** be applied under this ambiguity.

## Cleared for follow-up (informational)

- TypeScript and production build succeed on current branch.
- Migration file exists and is additive-only per static review.

## After migration apply (expected operational notes, from NEXT-SCANNER-02)

- Enrichment PATCHes against new columns remain best-effort until columns exist.
- Extended selects still intentionally unwired from default scanner reads until NEXT-SCANNER-03.
