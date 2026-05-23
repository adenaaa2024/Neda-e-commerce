# Old reference search — `returns` / `return` / scanner wording

Legend: **Changed** = updated in this run where it meant the physical scanner item table. **Intentional** = unrelated domain (Amazon, routes, JS “returns” keyword, etc.) or historical migration.

## Application TypeScript / TSX

| Location | Reference | Disposition |
|----------|-----------|-------------|
| `app/returns/actions.ts` | Comments `returns.photo_evidence`, `returns.pallet_id`, JSDoc “many returns”, “count for returns” | **Changed** → `return_items` / “return_items rows” where it denoted the table |
| `app/returns/_components.tsx` | JSDoc `` `returns.*` ``, UI `returns.photo_evidence` | **Changed** → `return_items` |
| `app/returns/page.tsx` | JSDoc “live `returns` rows”, “non-deleted returns” | **Changed** → `return_items` |
| `app/returns/returns-action-types.ts` | `` `returns.rma_number` ``, “column on `returns`” | **Changed** → `return_items` |
| `app/returns/claim-condition-labels.ts` | `` `returns.conditions` `` | **Changed** → `return_items.conditions` |
| `lib/return-photo-evidence.ts` | `` `returns.photo_evidence` `` | **Changed** → `return_items.photo_evidence` |
| `lib/import-returns-csv-map.ts` | `` `returns.conditions` `` | **Changed** → `return_items.conditions` |
| `app/claim-engine/claim-object.ts` | `` `returns.estimated_value` `` | **Changed** → `return_items.estimated_value` |
| `app/claim-engine/claim-print-html-actions.ts` | “from `returns`” in JSDoc | **Changed** → `return_items` |
| `app/claim-engine/logistics-sync-actions.ts` | “ready_for_claim returns” in JSDoc | **Changed** → `return_items` |
| `app/scanner/operator-mobile/item-actions.ts` | “Rolls back inserted returns”, “insert return” | **Changed** → `return_items` / “return item” |
| `lib/scanner/operator-tracking-expectations.ts` | “from `returns`”, `fetchReturnsScanned…` names | **Changed** → `return_items`; functions `fetchReturnItems…` |
| `app/scanner/operator-mobile/scan/page.tsx` | “save returns” (UI) | **Changed** → “save return items” |
| `app/scanner/operator-mobile/scan/page.tsx` | “/api/… returns INVALID…” (verb) | **Intentional** — English “returns” = API response |
| `ARCHITECTURE.md` | `` `returns` `` in landing zone | **Changed** → `return_items` |
| `app/returns/page.tsx` | `useState` variable `returns`, `listReturns()` | **Intentional** — UI/domain naming; function name kept |
| `app/returns/_components.tsx` | Prop names `returns:`, “RLS returns rows” (verb) | **Intentional** |
| `app/returns/returns-constants.ts` | `RETURNS_EMBED_SELECTOR` constant name | **Intentional** — embed key already `return_items` in claim constants |
| `types/database.types.ts` | Comment “renamed from `returns`”, deprecated `ReturnsRow` | **Intentional** — backward-compatible typing |
| `lib/pipeline/amazon-report-registry.ts` | `report_family: "returns"`, `domainTable: "amazon_returns"` | **Intentional** — Amazon reports |
| `lib/access-report-filters.ts`, `lib/sidebar-config.ts`, `lib/sidebar-catalog-extras.ts` | Module id `returns`, path `/returns` | **Intentional** — product module |
| `app/claim-engine/ClaimEngineClient.tsx` | User copy “returns” (workflow) | **Intentional** |
| `app/returns/actions.ts` | `.from("amazon_returns")` | **Intentional** — different table |
| `app/returns/loading.tsx` | “Loading returns…” | **Intentional** — screen title tone |

## Supabase SQL

| Location | Reference | Disposition |
|----------|-----------|-------------|
| `supabase/migrations/20260623120000_list_workspace_orgs_registry_and_names.sql` | `FROM public.returns` | **Changed** → `public.return_items` |
| `supabase/migrations/20260716120000_list_workspace_orgs_fn_return_items.sql` | (new) explicit `return_items` | **Added** |
| Pre-`20260515203000` migrations | `ALTER TABLE public.returns`, indexes `idx_returns_*` | **Intentional** — historical; table created as `returns` then renamed |
| `20260515203000_rename_returns_to_return_items.sql` | `ALTER TABLE public.returns RENAME` | **Intentional** — rename bridge |
| `expected_returns`, `amazon_returns`, `fba_customer_returns` | various | **Intentional** — not the scanner line table |

## Root / misc scripts

| Location | Reference | Disposition |
|----------|-----------|-------------|
| `database_optimization.sql` | `public.returns`, `idx_returns_*`, triggers `trg_audit_returns` | **Intentional left** — legacy DBA script; updating could confuse operators replaying old files. **Follow-up:** optional new script for `return_items`. |

## Grep spot-check after edits

- **No** `.from("returns")` in `*.ts` / `*.tsx`.
- **No** `` `returns.`` in app/returns or app/claim-engine for **column** documentation (table-qualified) after this pass.
