# Files changed

| File | Reason |
|------|--------|
| `supabase/migrations/20260623120000_list_workspace_orgs_registry_and_names.sql` | Post-rename bugfix: function body must query `return_items`, not `returns`, after rename migration runs. |
| `supabase/migrations/20260716120000_list_workspace_orgs_fn_return_items.sql` | **New** idempotent `CREATE OR REPLACE` so deployed DBs pick up explicit `return_items` wording / correct source. |
| `app/scanner/operator-mobile/item-actions.ts` | Scanner save path docs + error string: `return_items` terminology. |
| `lib/scanner/operator-tracking-expectations.ts` | Comments + renamed fetch helpers to `fetchReturnItems…` (internal-only exports). |
| `app/scanner/operator-mobile/scan/page.tsx` | Operator UI copy: “return items” instead of ambiguous “returns”. |
| `app/returns/actions.ts` | Comments / log messages: `return_items` instead of legacy table name in prose. |
| `app/returns/_components.tsx` | JSDoc + UI monospace: `return_items.*` for physical table. |
| `app/returns/page.tsx` | JSDoc: `return_items` row wording. |
| `app/returns/returns-action-types.ts` | JSDoc column references: `return_items`. |
| `app/returns/claim-condition-labels.ts` | File header: `return_items.conditions`. |
| `lib/return-photo-evidence.ts` | Module header: `return_items.photo_evidence`. |
| `lib/import-returns-csv-map.ts` | Comment: `return_items.conditions`. |
| `app/claim-engine/claim-object.ts` | JSDoc: `return_items.estimated_value`. |
| `app/claim-engine/claim-print-html-actions.ts` | JSDoc: `return_items` photo URLs. |
| `app/claim-engine/logistics-sync-actions.ts` | JSDoc: `return_items` vs generic “returns”. |
| `ARCHITECTURE.md` | Landing zone bullet: table name `return_items`. |
| `.cursor/audit-reports/scanner-return-items-rename-verify-01/run-20260515-001/*` | Required audit artifacts (`manifest.json`, markdown reports). |
