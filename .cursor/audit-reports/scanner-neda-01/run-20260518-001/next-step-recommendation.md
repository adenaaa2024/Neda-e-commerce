# Next step recommendation

1. **Smoke-test** operator-mobile identify gate + receive one SKU against dev/staging (confirm no 42703 in network tab).
2. **Re-probe** `identifier_resolution_source` on `return_items`; if present, add to `RETURN_SCANNER_LINKAGE_SELECT`.
3. When operator approves, apply `20260717120000_scanner_product_linkage_columns.sql` on staging, re-run `scripts/next-scanner-04-staging-e2e.ts`, then optionally restore EP extended selects and full return list select.
