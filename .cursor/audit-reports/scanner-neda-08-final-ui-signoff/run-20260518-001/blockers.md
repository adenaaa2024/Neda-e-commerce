# Blockers

| ID | Severity | Item | Status |
|----|----------|------|--------|
| — | — | None for final signoff criteria | **Clear** |

## Notes (non-blocking)

1. **Identify gate E2E match** — Fixture tracking `123` still has 0 `expected_packages` hits; gate schema is safe but full `idle` → `matched` automation needs an EP-backed tracking (same as NEDA-04).
2. **Slip linkage columns** — Full `RETURN_SCANNER_LINKAGE_SELECT` on `slip_contents` falls back to minimal columns on live DB (attempt 4); display degraded until migration, not a regression.
3. **NEDA-06 smoke row** — `ccffe8b3-…` remains on fixture; rollback when no longer needed (`scanner-neda-06/rollback-instructions.md`).
4. **Build hygiene** — `scanner-neda-06-small-write-smoke.ts` select list updated to include `resolved_catalog_product_id` so `npm run build` typecheck passes.
