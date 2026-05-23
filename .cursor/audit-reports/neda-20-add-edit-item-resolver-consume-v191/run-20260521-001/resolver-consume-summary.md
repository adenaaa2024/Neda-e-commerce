# Resolver-on-save consume — NEDA-20

## V191 Main audits
- operator-item-add-edit-resolver-standard-v191: **not in repo**
- inventory-expected-return-product-id-view-alignment-v191: **not in repo**

## Implemented surfaces
| Surface | Mechanism |
|---------|-----------|
| Add item (operator modal) | `previewOperatorItemBarcodeLinkageAction` on barcode edit; `insertOperatorPackageItemAction` returns `product_linkage` post-save |
| Save | Server actions only — `insertReturn` + enrichment; no browser `return_items` writes |
| Edit (returns drawer) | `updateReturn` + `applyReturnItemProductEnrichmentAfterUpdate`; edit barcode uses preview action |
| Detail | `fetchReturnItemProductLinkageAction` + `OperatorProductLinkageMeta` |
| Package/pallet child rows | Existing `listOperatorPackageItemsForPackageAction` / slip list `product_linkage` |
| Expected vs scanned | Quantity variance via `formatScanVarianceLabel`; product-id comparison deferred (V191 Main absent) |
