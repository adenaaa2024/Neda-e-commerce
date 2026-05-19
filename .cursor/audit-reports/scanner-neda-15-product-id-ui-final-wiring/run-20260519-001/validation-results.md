# SCANNER-NEDA-15 validation

**Run:** run-20260519-001  
**Overall:** **PASS**

| Step | OK | Detail |
|------|----|--------|
| prerequisite_v174 | ❌ | no v174 run (MISSING) — proceeded with local wiring |
| forbidden_package_items_zero | ✅ | refs=0 |
| forbidden_products_insert_zero | ✅ | refs=0 |
| forbidden_returns_table_zero | ✅ | refs=0 |
| forbidden_browser_db_writes_zero | ✅ | refs=0 |
| stale_select_package_number_zero | ✅ | refs=0 |
| stale_select_photo_url_scalar_zero | ✅ | refs=0 |
| wiring_contract_resolved_product_id | ✅ | true |
| wiring_contract_unmapped_label | ✅ | true |
| wiring_contract_needs_review_label | ✅ | true |
| wiring_shared_OperatorProductLinkageMeta | ✅ | true |
| wiring_page_uses_shared_meta | ✅ | true |
| wiring_page_no_inline_slip_meta | ✅ | true |
| wiring_page_primary_label | ✅ | true |
| wiring_modal_product_linkage_prop | ✅ | true |
| wiring_modal_shows_linkage_meta | ✅ | true |
| wiring_badges_ambiguous_needs_review | ✅ | true |
| wiring_actions_product_linkage_on_slip | ✅ | true |
| wiring_actions_product_linkage_on_items | ✅ | true |
| wiring_page_list_slip_action | ✅ | true |
| wiring_page_list_items_hydrate | ✅ | true |
| wiring_page_no_client_products_for_slip | ✅ | true |
| db_fixture_slip_rows | ✅ | count=2 |
| db_fixture_return_rows | ✅ | count=3 |
| db_resolved_contract_sample | ✅ | "none on fixture — unresolved-only ok" |
| db_unresolved_contract_sample | ✅ | {"product_name":null,"resolved_product_id":null,"identifier_resolution_status":"unresolved","identifier_resolution_confidence":0,"fallback_display_name":"Bob's Red Mill, Organic Medium Grind Cornmeal, 24 oz"} |
| db_ambiguous_contract_sample | ✅ | no ambiguous row on fixture — optional |
| unresolved_shows_unmapped_label | ✅ | No product link yet |
