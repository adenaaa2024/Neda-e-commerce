# Table linkage coverage matrix

| Surface | Data path | product_name | resolved_product_id | Status chips |
|---------|-----------|--------------|---------------------|--------------|
| Item inspection slip cards | `listOperatorSlipContentsForPackageAction` → `product_linkage` | ✅ primary label | ✅ meta (short id) | ✅ `OperatorProductLinkageMeta` |
| Item unit modal | slip row `product_linkage` | ✅ header | ✅ meta | ✅ shared meta |
| Package item hydrate | `listOperatorPackageItemsForPackageAction` | ✅ contract on rows | ✅ contract | used for counts (not row UI) |
| Identify gate EP lines | `scannerProductResolutionBadges` | SKU/FNSKU label | — | ✅ badges |

## Fixture samples

- Resolved: no
- Unresolved: yes
- Ambiguous: no (optional)
