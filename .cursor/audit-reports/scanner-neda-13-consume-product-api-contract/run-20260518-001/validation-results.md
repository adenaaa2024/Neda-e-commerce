# SCANNER-NEDA-13 validation

**Run:** run-20260518-001  
**Overall:** **PASS**

| Step | OK | Detail |
|------|----|--------|
| forbidden_package_items_zero | ✅ | refs=0 |
| forbidden_products_insert_zero | ✅ | refs=0 |
| wiring_contract_type_defined | ✅ | true |
| wiring_contract_has_product_name | ✅ | true |
| wiring_contract_has_fallback_name | ✅ | true |
| wiring_contract_has_confidence | ✅ | true |
| wiring_slip_row_has_product_linkage | ✅ | true |
| wiring_package_item_row_has_product_linkage | ✅ | true |
| wiring_list_slip_builds_linkage | ✅ | true |
| wiring_list_items_builds_linkage | ✅ | true |
| wiring_page_imports_contract | ✅ | true |
| wiring_page_primary_label | ✅ | true |
| wiring_page_linkage_meta_ui | ✅ | true |
| wiring_page_no_client_products_for_slip_linkage | ✅ | true |
| db_slip_linkage_select | ✅ | ok |
| db_return_items_linkage_select | ✅ | ok |
| db_fixture_hydrate_rows | ✅ | count=3 |
| db_unresolved_sample | ✅ | {"id":"e08156b5-6f59-4bad-9a33-330c500df9cd","status":"unresolved","resolved_product_id":null} |
| db_resolved_or_null_sample | ✅ | "none on fixture — unresolved-only ok" |
