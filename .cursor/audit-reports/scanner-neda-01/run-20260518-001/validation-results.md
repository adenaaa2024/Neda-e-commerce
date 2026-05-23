# Validation results

| Check | Command | Result |
|-------|---------|--------|
| Scanner helper tests | `npx tsx scripts/scanner-resolution-check.ts` | **PASS** (`scanner-resolution-check: ok`) |
| Production build | `npm run build` | **PASS** (TypeScript + static generation) |
| Live DB probe | Not run (no credentials in CI agent) | N/A — aligned to scanner-neda-02 probe |

## Safe fallbacks

- EP extended selects no longer default; existing `isMissingColumnError` retry kept for callers still passing `EP_*_WITH_SCANNER_PRODUCT_*`.
- Linkage UPDATE retries without optional columns.
- Slip server action: ordered select attempts (linkage first, then legacy lists).
- UI badges: `useScannerProductResolutionBadges` / `?? ""` — no throw on undefined fields.

## Not run (per task constraints)

- `20260717120000` migration apply
- Staging E2E (`next-scanner-04-staging-e2e.ts`)
- Production / Amazon / AI endpoints
