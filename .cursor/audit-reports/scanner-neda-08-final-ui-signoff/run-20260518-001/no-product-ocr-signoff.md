# No product created from OCR / title

## Policy

Operator-mobile must **not** insert into `products` from:

- Identify-gate OCR (`extractStrictIdentifyGateSlipCode`, Tesseract path)
- Slip `description` / `item_name` on save
- Packing-slip vision parse

## Static verification

| Check | Result |
|-------|--------|
| `products.insert` under `app/scanner/operator-mobile` | **None** |
| `insertOperatorPackageItemAction` | `insertReturn` only; `item_name` from slip description |
| `manualOverrideReturnItemProductResolution` | Comment + code: existing `products.id` only |
| `populateDraftFromEpRow` | `products` **select** by barcode for display (read-only) |

## NEDA-06 / fixture row

| Field | Value |
|-------|-------|
| `resolved_product_id` | `null` |
| `resolved_catalog_product_id` | `null` (insert payload) |
| Org `products` count | Unchanged during NEDA-06 smoke |

## Conclusion

**PASS** — OCR and slip text do not auto-create catalog products on operator-mobile.
