# Product linkage — return_items + EP

| Check | Result |
|-------|--------|
| RETURN_SCANNER_LINKAGE_SELECT probe | PASS |
| Active return_items on SAM package | 0 |
| Soft-deleted return_items (same package) | 0 (excluded from list action) |
| Rows with resolved_product_id | 0 |
| EP linkage primary label | X003UPTOJV · 2026JUN02-B0BNR1D6BL |
| Browser linkage copy | true |

**Contract:** `listOperatorPackageItemsForPackageAction` filters `deleted_at IS NULL` and builds `product_linkage` via `buildProductLinkageDisplayContract`.
