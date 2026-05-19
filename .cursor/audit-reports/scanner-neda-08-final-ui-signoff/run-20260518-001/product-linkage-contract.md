# Product linkage — current contract

## Constants (`app/returns/returns-constants.ts`)

```ts
RETURN_SCANNER_LINKAGE_SELECT =
  "resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence";
```

## Operator-mobile usage

| Surface | Contract |
|---------|----------|
| Manual override | `manualOverrideReturnItemProductResolution` — patches existing `products.id` only |
| Item-scan list | Omits linkage columns (by design); barcode ↔ slip matching for UI |
| Slip reads | Full linkage in select attempts; **fallback** on live DB when columns missing |
| OCR / identify | **No** `products.insert`; optional **read** by barcode for catalog display |

## Live DB probe (this run)

| Select | Result |
|--------|--------|
| `return_items` + linkage quartet | **OK** |
| `slip_contents` full linkage | Falls back to attempt 4 |

## Conclusion

**PASS** — linkage contract matches NEXT-SCANNER-02 partial schema; manual override and read probes succeed.
