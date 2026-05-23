# Scan lookup smoke results

| Step | Pass | Detail |
|------|------|--------|
| ui_route_scan_page | PASS | /scanner/operator-mobile/scan |
| lib_lookup_export | PASS | canonical API |
| lib_package_code_path | PASS | package code in lookup |
| no_product_resolver_in_gate | PASS | gate search block must not call product resolver |
| no_package_items_table | PASS | no package_items reference |
| no_returns_table_write | PASS | no returns table |
| uses_lookupShipmentEntryScanCode | PASS | canonical lookup wired |
| no_item_only_in_lookup_module | PASS | lookup module exists |
| lookup_excludes_products | PASS | lookup module skips products table |
| db_skipped | PASS | NEXT_PUBLIC_SUPABASE_URL / key not set — static checks only |
| db_skipped | PASS | NEXT_PUBLIC_SUPABASE_URL / key not set — static checks only |

## Summary

- **tracking/slip lookup**: PASS (static)
- **package code**: PARTIAL (no DB)
- **forbidden patterns**: PASS
