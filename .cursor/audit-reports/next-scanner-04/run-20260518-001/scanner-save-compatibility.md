# Scanner save compatibility (NEXT-SCANNER-04)

## Live save-path test

**Not run** — migration columns absent on linked DB; enrichment PATCH would no-op or error.

## Static behavior (pass)

`lib/scanner/apply-return-item-product-enrichment.ts`:

- Calls `resolveProductForScannerItem` after insert; never creates products.
- On ambiguous/unresolved resolution, still attempts PATCH with status fields; does not throw (logs on schema drift).
- Scanner receive path in `app/scanner/operator-mobile/item-actions.ts` inserts `return_items` then enrichment — **should still insert rows** when product unresolved (resolution failure does not roll back insert).

`resolveProductForScannerItem` (`lib/scanner/resolve-product-for-scanner-item.ts`):

- Returns `status: unresolved | ambiguous | resolved` without auto-picking among multiple matches.

## Expected post-migration

- Receive scan with unknown SKU → line saved; `identifier_resolution_status` unresolved; scanner flow continues.
- No product rows created by resolver (verified in 02/03 audits).

## Re-test after 02C

Manual: receive one item with unresolvable identifiers on dev/staging; confirm row exists and scanner UI advances.
