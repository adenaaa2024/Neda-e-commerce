# PC03A expected_packages source identifier fix

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Production / original | forbidden |
| Product creation | forbidden |

```text
APPROVED_TO_RUN_STAGING=false
APPROVED_PC03A_EXPECTED_PACKAGES_SOURCE_FIX=false
```

## Scope

- **Dirty source-fix cohort:** 38 rows (`UNKNOW` SKU, ASIN stored in `fnsku`, etc.)
- **Exact map-only (clean):** 0 rows → `product_identifier_map` insert only (read-layer; no `expected_packages` bulk update)
- Plan: `.cursor/audit-reports/pc03a-expected-return-slip-map-only-execute-plan/20260523T040000Z/`

## Preconditions

- [ ] Operator confirms corrected `sku`/`fnsku` values per dirty row before any map wave
- [ ] Map-only inserts only for rows in `exact-map-only-candidates.json` expected_packages section
- [ ] No product creation

## Sign-off

```
APPROVED_TO_RUN_STAGING=false
APPROVED_PC03A_EXPECTED_PACKAGES_SOURCE_FIX=false
Approved by:
UTC date:
```
