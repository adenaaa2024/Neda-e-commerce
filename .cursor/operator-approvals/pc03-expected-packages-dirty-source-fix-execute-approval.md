# PC03 expected_packages dirty source fix — execute approval

**Default:** not approved. Required before governed source identifier UPDATE on dirty EP rows.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Allowed write | UPDATE `expected_packages.sku` / `expected_packages.fnsku` for approved rows in plan |
| Forbidden | product create; bulk `resolved_product_id` update; production/original |
| Plan | `.cursor/audit-reports/pc03-expected-packages-dirty-source-quarantine-plan/20260523T050000Z/` |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_PC03_EXPECTED_PACKAGES_DIRTY_SOURCE_FIX=true
```

## Scope

- Dirty cohort: **38** rows
- High-confidence auto-fix candidates: **21**
- Post-fix map-only preview: **21** (confirm via PC03A re-run)

## Preconditions

- [ ] Review `proposed-source-fixes.json`
- [ ] Operator confirms no ASIN/FNSKU swap regressions per cluster (`cluster-map.md`)
- [ ] Map-only execute is **separate** prompt after source fix + PC03A re-run

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_PC03_EXPECTED_PACKAGES_DIRTY_SOURCE_FIX=true
Approved by: Maysam Ebrahimi
UTC date: 05232026
```
