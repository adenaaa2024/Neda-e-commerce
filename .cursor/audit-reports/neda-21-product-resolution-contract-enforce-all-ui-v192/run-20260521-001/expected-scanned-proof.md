# Expected / scanned proof

| Panel | Read path | Product linkage |
|-------|-----------|-----------------|
| Expected inventory lines | `fetchVInventoryItemStatusLinesExact` + EP merge | `ExpectedInventoryLineRow` + `OperatorProductLinkageMeta` |
| Expected packages (tracking gate) | `fetchExpectedPackagesForTracking` / snapshot | EP SKU/FNSKU; no EP `identifier_resolution_status` SELECT |
| Scanned counts | `operatorReceiveItem` bumps `expected_packages.actual_scanned_count` | quantity only; product via `return_items` rows |

Browser expected panel: visible
Browser inventory signals: visible
