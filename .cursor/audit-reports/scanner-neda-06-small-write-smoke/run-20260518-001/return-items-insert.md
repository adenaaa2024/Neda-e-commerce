# return_items insert verification

## Insert

- **Table:** `return_items` (not `package_items`)
- **Row id:** `ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663`
- **package_id:** `9528d923-3d27-4aed-a773-095b5028743d`
- **fnsku:** `X004N9OS4J`
- **conditions:** `["sellable_ok"]`
- **status:** `received`
- **resolved_product_id:** null

## App code path (production UI)

1. `handleItemUnitModalSave` → `insertOperatorPackageItemAction`
2. `insertReturn` → `.from(RETURN_ITEMS_TABLE).insert(...)`

## Conclusion

**PASS** — exactly one new `return_items` row for this smoke run.
