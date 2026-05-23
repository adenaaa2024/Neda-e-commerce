# Blockers

**None** for code repair and local build.

## Follow-ups (non-blocking)

1. **Slip linkage is derived, not stored** — `return_items` has no `slip_content_id` column on live DB; re-hydration matches barcode → slip line. Ambiguous duplicate barcodes on one slip may bucket incorrectly.
2. **`types/database.types.ts` still lists `package_items`** — harmless for PostgREST if unused; remove or mark optional when types are regenerated.
3. **Product enrichment after insert** — `applyReturnItemProductEnrichmentAfterInsert` may warn on partial linkage columns (scanner-neda-02); does not block insert.
