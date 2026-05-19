# Blockers

## None for runtime table name (app code)

- Application queries for scanner / returns-processing line items go through **`RETURN_ITEMS_TABLE`** (`return_items`) or embedded FK keys already named **`return_items`** in claim constants.

## Follow-ups (not blocking deploy of this rename)

1. **Historical SQL** — Older migrations and `database_optimization.sql` still say `public.returns` because they describe the schema **before** the rename migration. Fresh replays rely on `20260515203000_rename_returns_to_return_items.sql` plus post-rename migrations using `return_items` (see fixed `20260623120000…` and new `20260716120000…`).

2. **Naming drift (optional)** — Server actions remain `insertReturn`, `listReturns`, `countReturns`, route `/returns`, and UI state variable `returns` for `ReturnRecord[]`. These are **domain language**, not the Postgres table name. Rename only if product wants API/UI consistency.

3. **Deprecated type alias** — `ReturnsRow` in `types/database.types.ts` remains as `@deprecated` alias of `ReturnItemsRow`; consumers can migrate gradually.

4. **ESLint** — `app/returns/_components.tsx` has existing `react-hooks/set-state-in-effect` errors when linted with `--max-warnings` / `--quiet`; unrelated to table rename.

5. **Amazon / import tables** — `amazon_returns`, `expected_returns`, `fba_customer_returns`, report_family `"returns"` are **separate** business concepts and were **not** renamed.
