# Validation results (SCANNER-02C)

| Check | Result | Notes |
|-------|--------|-------|
| Operator approval file | **Fail (gate)** | `.cursor/operator-approvals/scanner-02c-dev-staging-approval.md` missing |
| Dev/staging env markers | **Fail (gate)** | None in `.env.local` or shell |
| Environment = confirmed dev/staging | **Fail (gate)** | See `environment-confirmation.md` |
| Migration file exists | **Pass** | `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql` |
| Apply migration | **Skipped (blocked)** | — |
| Live schema verification SQL | **Skipped (blocked)** | Template in `schema-verification.md` |
| `npx tsc --noEmit` | **Pass** | Exit 0 |
| `npm run build` | **Pass** | Next.js 16.1.7; exit 0 |
| `.from("returns")` in `app/` / `lib/` | **Pass** | No matches |
| `RETURN_ITEMS_TABLE` usage | **Pass** | Table name `return_items` |
| Scanner smoke / E2E | **Skipped** | Blocked on env + migration |
| `npx tsx scripts/scanner-resolution-check.ts` | **Not run** | Pure unit-style; optional; blocked run focused on DB gate |

## Preflight reads

- `scanner-02b-apply-migration-dev-verify/run-20260515-003/` — prior blocked run (same env finding)
- `next-scanner-02/run-20260515-002/` — migration and resolver design
