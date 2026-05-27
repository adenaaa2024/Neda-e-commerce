# Spreadsheet packaging import — staging operator approval

**Scope:** Governed INSERT into `product_packaging_profiles` + `product_packaging_profile_versions` on **staging only** (`eiqfaapyumhixxoeltgu`) from product dimensions spreadsheet census (`import_ready` cohort).

**Default:** not approved.

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_SPREADSHEET_PACKAGING_IMPORT=true
```

## Allowed when approved

| Allowed | Forbidden |
|---------|-----------|
| Staging INSERT packaging profiles + versions (`needs_review`) | `profile_status=active` in same execute |
| `source_type=import`, batch tag `SPREADSHEET_DIMENSIONS_<run_id>` | Direct `dimensions_current` INSERT/UPDATE |
| `dimension_unit=in`, `weight_unit=lb` | `products` UPDATE/INSERT |
| Read plan from `spreadsheet-governed-import-plan/<run_id>/packaging-insert-plan.json` | `product_identifier_map` INSERT |
| Post-insert snapshot counts | Original/current (`kxsvedvpjldygtdbylsy`) |
| | Amazon SP-API |
| | AI / OpenAI |

## Preconditions

- [ ] Review `.cursor/audit-reports/spreadsheet-staging-match-census/<census_run_id>/`
- [ ] Review `.cursor/audit-reports/spreadsheet-governed-import-plan/<run_id>/packaging-insert-plan.json`
- [ ] Confirm **80** import_ready rows (or current census count)
- [ ] `dimensions_current` baseline **491** — must not increase until separate activate approval

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_SPREADSHEET_PACKAGING_IMPORT=true
Approved by: Maysam Ebrahimi
UTC date: 05262026
```
