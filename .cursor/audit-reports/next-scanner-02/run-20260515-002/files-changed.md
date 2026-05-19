# Files changed

| File | Purpose |
|------|---------|
| `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql` | Additive nullable columns + indexes + FKs for `expected_packages`, `return_items`, `slip_contents`. |
| `lib/scanner/resolve-product-for-scanner-item.ts` | **New** deterministic resolver per prompt. |
| `lib/scanner/apply-return-item-product-enrichment.ts` | **New** post-insert enrichment for `return_items`. |
| `lib/scanner/enrich-slip-contents-product-links.ts` | **New** post-insert slip line enrichment. |
| `lib/scanner/product-resolution-badges.ts` | **New** badge label/color helpers. |
| `lib/scanner/operator-tracking-expectations.ts` | Extended group aggregation; `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` export. |
| `app/returns/actions.ts` | `insertReturn` calls enrichment after insert; `expected_item_id` on payload handled in enrichment. |
| `app/returns/returns-action-types.ts` | `ReturnInsertPayload.expected_item_id`; `ReturnRecord` optional linkage fields. |
| `app/returns/returns-constants.ts` | `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` for post-migration list reads. |
| `app/scanner/operator-mobile/item-actions.ts` | Pass `expected_item_id` into receive insert payload. |
| `app/scanner/operator-mobile/_components/operator-store-actions.ts` | Fire-and-forget slip enrichment after successful replace insert. |
| `app/scanner/operator-mobile/scan/page.tsx` | Resolution badges on expected inventory rows. |
| `hooks/use-scanner-product-resolution.ts` | **New** memoized badge hook. |
| `types/database.types.ts` | Document new columns on `ReturnItemsRow` / `SlipContentsRow`. |
| `.cursor/audit-reports/next-scanner-02/run-20260515-002/*` | Audit artifacts. |
