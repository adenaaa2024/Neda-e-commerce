# Detail hydration proof

| Surface | Hydration mechanism |
|---------|---------------------|
| Item drawer (returns) | `fetchReturnItemProductLinkageAction` → `hydrateReturnItemProductLinkage` |
| Post insert (operator) | `insertOperatorPackageItemAction` returns `product_linkage` |
| Package units list | `listOperatorPackageItemsForPackageAction` builds contract from row + `fetchProductNamesByResolvedIds` |
| Slip lines | `listOperatorSlipContentsForPackageAction` `product_linkage` field |

No client `products` catalog queries on scan page: confirmed
