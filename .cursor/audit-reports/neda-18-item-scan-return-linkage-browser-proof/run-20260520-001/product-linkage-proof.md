# Product linkage — return_items (fixture package)

| Field | Value |
|-------|-------|
| Package code | `PKG-MNI9DR05` |
| actual_item_count | 0 |
| Active return_items | 2 |
| Soft-deleted return_items | 0 |
| RETURN_SCANNER_LINKAGE_SELECT | `resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence` |

## Active rows (labels redacted)

| id (prefix) | primary_label | unmapped | needs_review | catalog |
|-------------|---------------|----------|--------------|---------|
| f3a3ad84… | MAysam 22 | true | false | false |
| bd5bf0d6… | Item Neda | true | false | false |

**UI contract:** `OperatorProductLinkageMeta` shows `No product link yet`, `Needs review`, or catalog `product_name` from `buildProductLinkageDisplayContract`.
