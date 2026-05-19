# Preflight — scanner `return_items` rename verification

## Source audit

Latest folder: `.cursor/audit-reports/scanner-return-items-rename-verify-01/run-20260515-001/`

## Gate result: **PASS (proceed)**

| Artifact | Outcome |
|----------|---------|
| `blockers.md` | **None** for runtime table name; follow-ups are historical SQL naming, ESLint noise on `app/returns/_components.tsx`, Amazon domain tables unchanged. |
| `old-reference-search.md` | No `.from("returns")` in app `*.ts`/`*.tsx`; intentional leftovers documented (migrations before rename, `database_optimization.sql`, Amazon `amazon_returns` / routes). |
| `database-contract.md` | Canonical scanner line table `public.return_items`; rename is in-place OID preserve; app uses `RETURN_ITEMS_TABLE`. |
| `scanner-flow-impact.md` | Save path `insertReturn` → `return_items`; read path `operator-tracking-expectations` uses `RETURN_ITEMS_TABLE`. |
| `validation-results.md` | `npx tsc --noEmit` PASS; `npm run build` PASS in prior run; ESLint pre-existing errors on returns components noted. |
| `files-changed.md` | Rename cleanup scoped to scanner/returns/claim comments + migrations. |

## Conclusion

No blocking issue for NEXT-SCANNER-02. Amazon / customer “returns” tables and routes remain intentional non-scanner concepts.
