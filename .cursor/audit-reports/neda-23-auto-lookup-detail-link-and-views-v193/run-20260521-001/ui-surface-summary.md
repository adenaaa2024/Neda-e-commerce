# NEDA-23 UI surface summary

## Changes

| Surface | Behavior |
|---------|----------|
| Operator scan (slip, expected lines, item modal) | `ProductLinkagePrimaryLink` → `/scanner/operator-mobile/products/{product_id}` when resolved |
| `OperatorProductLinkageMeta` | Short product id chip links to same detail route |
| Returns wizard Step 1 | `previewOperatorItemBarcodeLinkageAction` on blur/scan; linkage meta; no client `products` / Amazon |
| Returns item drawer (edit) | Same server preview; manual override uses `searchOperatorProductsForStoreAction` |
| Expected / scanned | `mergeExpectedWithScannedCounts` prefers `scannedByProductId` when EP row has `expected_product_id` |
| SP-API mock button | Hidden unless `NODE_ENV === "development"` |

## Server actions (new)

- `fetchOperatorProductDetailAction`
- `searchOperatorProductsForStoreAction`

## Forbidden scan

`package_items=0`, `returns table=0`, `products.insert=0`, client `products.select=0`
