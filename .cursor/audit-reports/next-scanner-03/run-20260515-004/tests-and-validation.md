# Tests and validation

| Check | Result | Notes |
|-------|--------|-------|
| `npx tsc --noEmit` | Pass | Exit 0 |
| `npx tsx scripts/scanner-resolution-check.ts` | Pass | Badge keys + `aggregateExpectedPackagesBySkuFnskuDisposition` mismatch merge |
| ESLint (touched files) | Pre-existing failures in `app/returns/_components.tsx` | `react-hooks/set-state-in-effect` and other issues at lines unrelated to this run’s scanner panel; full-file lint still exits 1 |
| `npm run lint` (repo-wide) | Not re-run | 02b already noted repo-wide lint debt |
| Live scanner read smoke | Not run | Blocked until migration applied on configured Supabase |

## Suggested follow-up QA (post-migration)

1. Open operator scan → identification gate with EP rows that have linkage columns populated → confirm chips render.
2. Receive item → open return in Items UI → confirm list row includes linkage fields → drawer review panel + manual override round-trip.
3. Confirm PostgREST `select` on `return_items` list endpoints returns new columns without 400 errors.
