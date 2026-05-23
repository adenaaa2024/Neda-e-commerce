# Approved read paths

| Prompt name | Repo implementation | Notes |
|-------------|---------------------|-------|
| fetchExpectedPackagesNedaRead | `fetchExpectedPackagesForTracking`, `loadTrackingExpectationSnapshot`, `enrichTrackingOperatorLinesWithProductLinkage` | Primary EP read |
| GET /api/returns/expected-packages-linkage | — | Not present; optional path unused |
| fetchInventoryItemStatusForNeda | `fetchVInventoryStatusForScanCode`, `fetchVInventoryItemStatusLinesExact` | `v_inventory_item_status` view |
| v_inventory_status | Migration + optional PostgREST probe | Package-level chips; not queried from TS today |
| v_scanned_items_counted | — | Not in repo; scanned qty via `fetchReturnItemsScannedBySkuFnsku*` on `return_items` |

**Staging scope:** org `00000000-0000-0000-0000-000000000001`, store `509ee1f6-622c-46a5-8110-7b889ba46c2c` (Sam).
