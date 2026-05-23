# Blockers

**None** for package_items reference repair.

## Follow-ups (non-blocking)

1. **`types/database.types.ts` still lists `package_items`** — harmless if unused; regenerate types when convenient.
2. **Operator smoke on staging** — confirm save + reload hydration with a real package (see `validation-results.md`).
3. **Optional future migration** — `slip_content_id` on `return_items` if barcode-derived slip match is insufficient (not in scope).
