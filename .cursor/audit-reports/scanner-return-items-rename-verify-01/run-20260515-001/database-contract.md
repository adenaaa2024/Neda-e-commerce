# Database contract — scanner item table

## Final table name

- **Canonical physical table:** `public.return_items` (PostgREST / Supabase client: `return_items`).

## Data preservation

- **No table drop or recreate** was performed in this task. The repo already includes an idempotent rename migration (`supabase/migrations/20260515203000_rename_returns_to_return_items.sql`) that renames `public.returns` → `public.return_items` when the old name still exists.
- Row data is preserved by **in-place rename** (same relation OID); this audit did not run migrations against a live database.

## Compatibility view

- **No `returns` compatibility view** is defined in the migrations reviewed for this pass. Application code uses `RETURN_ITEMS_TABLE` (`"return_items"`) and generated types under `Database["public"]["Tables"]["return_items"]`.

## Migrations / apply status

- This run **did not apply** Supabase migrations to any remote project; only repository sources were updated.
- **New migration added:** `20260716120000_list_workspace_orgs_fn_return_items.sql` — `CREATE OR REPLACE` for `list_workspace_organizations_for_admin()` so environments that already ran the older function body get an explicit `return_items` reference.
- **Corrected migration:** `20260623120000_list_workspace_orgs_registry_and_names.sql` — the subquery now reads from `public.return_items` so **fresh** `supabase db reset` / linear replay after the rename migration succeeds (previously referenced `public.returns` after rename and would fail).
