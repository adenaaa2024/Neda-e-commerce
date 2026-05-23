# Fixture and single write

## Fixture (reused from neda-04)

| Field | Value |
|-------|-------|
| `package_id` | `9528d923-3d27-4aed-a773-095b5028743d` |
| `organization_id` | `7397edff-7994-4731-8501-55d258d507d2` |
| `store_id` | `9adfe198-7c6a-49a5-b0b4-d370a83de06f` |
| `tracking_number` | `123` |
| `package_code` | `1231` |
| Slip lines | 2 (matchable FNSKU on first line) |

## Write performed

| Field | Value |
|-------|-------|
| Barcode scanned (simulated) | `X004N9OS4J` (FNSKU) |
| Match tier | `fnsku` |
| Slip line id | `f4010b57-3ea8-4c2c-b545-670d10b50e82` |
| Conditions | `["sellable_ok"]` |
| `return_items.id` | `ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663` |
| `return_items` count before → after | 2 → 3 |

## Parity with UI save

Insert payload mirrors `insertOperatorPackageItemAction` → `insertReturn` (`operator-store-actions.ts`): same org/store/package, slip description as `item_name`, FNSKU column, `sellable_ok` tag, no product linkage.

## Conclusion

**PASS** — one scoped write on approved fixture package.
