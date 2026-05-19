# Validation results

| Check | Result | Notes |
|-------|--------|-------|
| Preflight: read NEXT-SCANNER-02 audit dir | Pass | `.cursor/audit-reports/next-scanner-02/run-20260515-002/` |
| Migration file exists | Pass | `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql` |
| Environment = confirmed dev/staging | **Fail (gate)** | See `environment-check.md` |
| Apply migration | **Skipped (blocked)** | — |
| Live schema verification query | **Skipped (blocked)** | SQL template in `schema-verification.md` |
| `npx tsc --noEmit` | Pass | Exit 0 |
| `npm run build` | Pass | Exit 0 |
| `.from("returns")` in `app/` / `lib/` ts, tsx | Pass | No matches |
| `npm run lint` | **Fail (pre-existing)** | ESLint exits 1 with many issues across the repo (e.g. `react-hooks/set-state-in-effect` in admin settings, large file note for `app/scanner/operator-mobile/scan/page.tsx`). Not introduced by this audit run. |

## Scanner smoke

Not executed (blocked on environment + migration).
