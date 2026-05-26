# PC07 expected_packages dirty source fix — execute approval

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| `APPROVED_TO_RUN_STAGING` | `false` |
| `APPROVED_PC07_DIRTY_SOURCE_FIX` | `false` |
| Plan | `.cursor/audit-reports/pc07-expected-packages-dirty-source-quarantine-plan/20260526T130000Z/quarantine-plan.md` |
| Rows | 38 |

## Allowed write

UPDATE `expected_packages.sku` / `expected_packages.fnsku` for approved dirty rows only.

## Forbidden

product create; `product_identifier_map` insert; bulk `resolved_product_id`; production/original; Amazon API in same execute.

```
APPROVED_TO_RUN_STAGING=false
APPROVED_PC07_DIRTY_SOURCE_FIX=false
```
