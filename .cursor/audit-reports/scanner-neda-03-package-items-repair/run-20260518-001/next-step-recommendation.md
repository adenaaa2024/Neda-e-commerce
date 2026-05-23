# Next step recommendation

1. **Operator smoke** on staging: item-scan save + reload hydration (see `validation-results.md`).
2. If product linkage columns are required on `return_items`, apply `20260717120000_scanner_product_linkage_columns.sql` on staging only after operator approval (scanner-02c pattern) — separate from this repair.
3. Optional: add `slip_content_id` UUID on `return_items` in a future approved migration if derived barcode matching proves insufficient.
