# No `package_items` usage

## Application

| Scope | `package_items` references |
|-------|---------------------------|
| `app/scanner/operator-mobile/**` | **0** |
| Save/hydrate paths | `RETURN_ITEMS_TABLE` only |

Legacy UI name `packageItemsHydrationNonce` remains (nonce for re-fetch); **no** PostgREST table access.

## Live database

| Probe | Result |
|-------|--------|
| `from("package_items").select("id").limit(1)` | **PGRST205** / table not found (expected) |

## Types note

`types/database.types.ts` may still document `package_items` for historical codegen — **not** used by operator-mobile runtime.

## Conclusion

**PASS** — operator-mobile item scan is fully on `return_items`.
