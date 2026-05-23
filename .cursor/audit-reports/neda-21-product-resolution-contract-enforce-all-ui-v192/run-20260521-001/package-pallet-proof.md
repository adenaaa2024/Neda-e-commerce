# Package / pallet proof

| Surface | Server action | Linkage on child rows |
|---------|---------------|------------------------|
| Package scanned units | `listOperatorPackageItemsForPackageAction` | `product_linkage` per row |
| Slip lines in package view | `listOperatorSlipContentsForPackageAction` | `product_linkage` |
| Pallet package picker | `listOperatorPackagesForPalletAction` | opens package → slip/items hydrate |

Staging list contract probe: PASS

**Verdict:** PASS
