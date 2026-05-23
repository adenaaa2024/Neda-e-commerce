# package_items not used

## Live database

- Probe: `SELECT id FROM package_items LIMIT 1`
- Result: **PGRST205** — table not in schema cache (expected)

## Application (`app/scanner`, `lib/scanner`)

- **Zero** `package_items` string references in operator-mobile and scanner lib paths.
- Persistence: `listOperatorPackageItemsForPackageAction` / `insertOperatorPackageItemAction` → **`return_items`** only.

## Migrations

- **Not run** in this audit.

## Conclusion

**PASS** — no `package_items` query, table, or migration involved.
