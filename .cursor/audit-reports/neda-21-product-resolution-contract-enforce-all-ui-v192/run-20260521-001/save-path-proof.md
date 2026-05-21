# Save path proof

## Approved chain (non-negotiable)

```
UI input → approved server action → resolver-on-save → persist resolved_product_id → ProductLinkageDisplayContract → render
```

| Save surface | Action | Writes `return_items`? | Resolver |
|--------------|--------|-------------------------|----------|
| BOX item modal save | `insertOperatorPackageItemAction` | via `insertReturn` | `applyReturnItemProductEnrichmentAfterInsert` + `hydrateReturnItemProductLinkage` on response |
| EP item receive | `operatorReceiveItem` | via `insertReturn` | enrichment on insert |
| Returns drawer save | `updateReturn` | server `supabaseServer` | `applyReturnItemProductEnrichmentAfterUpdate` when identifiers change |
| Returns bulk add | `insertReturn` in `_components` | server only | enrichment on insert |

## Forbidden (operator-mobile + returns UI)

| Pattern | Hits |
|---------|------|
| package_items | 0 |
| .from("returns") | 0 |
| products.insert | 0 |
| client return_items write | 0 |

**Verdict:** PASS

Browser: signed_in=true server_action_200=true labels=X00525Q5XZ, X004DMS1TT, no_product_link_yet
