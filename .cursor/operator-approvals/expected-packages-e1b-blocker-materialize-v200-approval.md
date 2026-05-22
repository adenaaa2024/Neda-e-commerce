# Expected Packages E1B Blocker Materialize V200 Approval

**Required before** governed `products` + `product_identifier_map` inserts and scoped import `product_id` remaps for the 10 orphan E1B blockers.

| Field | Value |
|---|---|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Allowed writes | INSERT `products` + `product_identifier_map` for 10 approved orphan cohorts; scoped UPDATE import `product_id`/`resolved_product_id` on rows referencing those orphans only |
| Expected package update | forbidden |
| Production/original | forbidden |
| Source | trusted `amazon_manage_fba_inventory` (+ peer rows tied to same orphan id) |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_EXPECTED_PACKAGES_E1B_BLOCKER_MATERIALIZE_V200=true
```
