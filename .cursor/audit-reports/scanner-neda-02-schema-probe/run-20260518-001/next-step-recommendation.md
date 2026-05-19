# Next step recommendation

## 1. Apply migration (operator-approved)

Apply `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql` to project `kxsvedvpjldygtdbylsy`, then:

```sql
-- Expect 11 / 13 / 15 rows respectively
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'expected_packages'
  AND column_name IN (
    'expected_product_id','resolved_product_id','resolved_catalog_product_id',
    'identifier_resolution_status','identifier_resolution_confidence',
    'identifier_resolution_source','identifier_resolution_meta',
    'product_match_status','product_review_required','product_resolved_at','product_resolved_by'
  );
-- repeat for return_items (13 cols) and slip_contents (15 cols)
```

Re-run **SCANNER-NEDA-02** probe or `scripts/next-scanner-04-staging-e2e.ts` preflight.

## 2. Investigate partial 4-column state

Before apply, confirm on host DB whether `return_items` / `slip_contents` resolution columns came from manual DDL. If stray, consider aligning with full migration (additive `IF NOT EXISTS` is safe).

## 3. Fix `EP_SELECT` / `asin` drift

Either add `expected_packages.asin` via migration or remove `asin` from `EP_SELECT` in `lib/scanner/operator-tracking-expectations.ts` so tracking fetches work **pre-** linkage migration.

## 4. Apply `slip_contents.notes` if missing

Migration `20260641130000_slip_contents_notes.sql` may not have run on this project — apply if operators need line-level flags in DB.

## 5. After schema PASS

- Enable `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` / `EP_*_WITH_SCANNER_PRODUCT_SELECT` read paths.
- Re-verify enrichment UPDATE paths and NEXT-SCANNER-04 E2E.

Prior audits: `.cursor/audit-reports/next-scanner-04/run-20260518-001/`, `scanner-02c-confirm-staging-apply-verify/run-20260518-001/`.
