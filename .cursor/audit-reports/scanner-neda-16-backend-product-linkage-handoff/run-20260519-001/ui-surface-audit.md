# UI surface audit

## Server actions (approved)

- `listOperatorSlipContentsForPackageAction` — builds `ProductLinkageDisplayContract` per slip line
- `listOperatorPackageItemsForPackageAction` — `product_linkage` on return_item rows
- `insertOperatorPackageItemAction` — writes `return_items` (not `package_items`)

## Client

- No browser Supabase writes on item-scan save path
- Slip/return product names resolved server-side via `fetchProductNamesByResolvedIds`
- EP identify gate may still read `products` for barcode lookup (out of slip-linkage scope)

## Note

`return_items` rows on fixture DB are smoke/test data; do not use for production KPIs.
