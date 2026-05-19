# UI copy signoff

| State | Required copy | Implementation |
|-------|---------------|----------------|
| Unmapped | No product link yet | `productLinkageShowsUnmappedLabel` + `OperatorProductLinkageMeta` |
| Ambiguous | Needs review | `productLinkageIsAmbiguous` + badge label |
| Resolved | Product linked + short id | `scannerProductResolutionBadges` + `resolved_product_id` prefix |
