# Blockers

## None for merging this branch (code-level)

- Rename preflight passed; no active `.from("returns")` in application TypeScript.
- Product linkage writes are best-effort updates after primary insert; missing migration surfaces as console warnings, not hard save failure.

## Operational / rollout

1. **Migration must be applied** before new columns exist; until then enrichment PATCHes no-op with PostgREST errors logged.
2. **Extended selects** (`RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT`, `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT`) must be wired into specific read paths when the UI should show DB-backed resolution on lists — default selects intentionally conservative.

## Follow-ups (non-blocking)

- Wire `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` into `fetchExpectedPackageDetailRowsByIds` once migration is guaranteed in an environment.
- Optional `package_items` linkage if ITEM scan needs per-unit product identity.
- ESLint clean-up for `scan/page.tsx` hooks rule violations (pre-existing scope).
