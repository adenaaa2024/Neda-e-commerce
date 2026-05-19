# Product linkage signoff

## Static wiring

```json
{
  "contract_defined": true,
  "actions_build_linkage": true,
  "slip_rows_product_linkage": true,
  "page_OperatorSlipProductLinkageMeta": true,
  "page_unresolved_ui": true,
  "page_no_product_found": true,
  "page_primary_label": true,
  "list_slip_action": true,
  "list_items_action": true,
  "insert_action": true
}
```

## DB-built contracts (fixture)

- Slip linkages: 2
- Return linkages: 3
- Unresolved sample in data: yes
- Fallback primary label: yes

## Browser

| UI signal | Visible |
|-----------|---------|
| Unresolved badge | no |
| No product found | no |

Contract: `ProductLinkageDisplayContract` via `listOperatorSlipContentsForPackageAction` / `listOperatorPackageItemsForPackageAction` only.
