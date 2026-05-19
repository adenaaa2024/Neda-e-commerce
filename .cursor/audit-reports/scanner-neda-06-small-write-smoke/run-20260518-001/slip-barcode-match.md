# Slip line count / barcode match

## Slip contents

| slip_content_id | fnsku | upc |
|-----------------|-------|-----|
| `f4010b57-3ea8-4c2c-b545-670d10b50e82` | `X004N9OS4J` | (see DB) |
| (second line) | — | — |

## Match logic

Uses `resolveItemBarcodeAgainstSlipRows` (FNSKU tier before UPC), same as operator scan handler.

| Check | Result |
|-------|--------|
| Resolve `X004N9OS4J` | `single` / tier `fnsku` |
| Hydrated `slip_content_id` | `f4010b57-3ea8-4c2c-b545-670d10b50e82` |
| Matches expected slip line | **Yes** |

## Conclusion

**PASS** — slip line count unchanged; barcode maps to the correct slip row.
