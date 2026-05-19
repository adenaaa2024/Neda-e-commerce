# Neda contract snippet (ProductLinkageDisplayContract)

Derived from `lib/scanner/product-linkage-display-contract.ts` — use server action rows only.

```ts
export type ProductLinkageDisplayContract = {
  product_name: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: number | null;
  fallback_display_name: string;
};
```

## Actions

| Action | Field |
|--------|-------|
| `listOperatorSlipContentsForPackageAction` | `rows[].product_linkage` |
| `listOperatorPackageItemsForPackageAction` | `rows[].product_linkage` |

## UI

- Primary label: `productLinkagePrimaryLabel(product_linkage)`
- Badges: `scannerProductResolutionBadges({ identifier_resolution_status })`
- Confidence: `formatProductLinkageConfidencePct(confidence)` when resolved
- Amber **No product found** + **Unresolved** warning badges; fallback subtitle when catalog name differs from slip text
