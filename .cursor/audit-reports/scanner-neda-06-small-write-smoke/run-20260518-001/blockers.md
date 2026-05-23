# Blockers

| ID | Severity | Item | Status |
|----|----------|------|--------|
| — | — | None for automated smoke | **Clear** |

## Notes (non-blocking)

1. **Fixture had prior scans** — package already had 2 `return_items` before this run; smoke added a 3rd. Rollback SQL targets only the smoke row `ccffe8b3-…`.
2. **`packages.actual_item_count`** — null before/after on fixture; trigger behavior not validated here.
3. **Browser UI** — not exercised live; DB parity + static path sufficient for neda-06 scope.
