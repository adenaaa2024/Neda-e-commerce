# Vendor 1883 cleanup — staging operator approval

**Scope:** Governed `products.vendor_name` UPDATE on **staging only** (`eiqfaapyumhixxoeltgu`) — replace bare `1883` with spreadsheet `Brand` values starting with `1883`.

**Default:** not approved.

| Field | Value |
|-------|--------|
| Plan review | `.cursor/audit-reports/vendor-1883-cleanup-plan-review/20260528T120000Z/` |
| Deterministic rows | **454** |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_VENDOR_1883_CLEANUP=true
```

## Allowed when approved

| Allowed | Forbidden |
|---------|-----------|
| Staging `UPDATE products SET vendor_name = ...` for deterministic plan rows only | Packaging table writes |
| Before/after audit JSON per run | `product_identifier_map` INSERT |
| Rollback script from execute audit | Original/current |
| | Product auto-create |
| | Amazon SP-API |

## Preconditions

- [ ] Review `.cursor/audit-reports/vendor-1883-cleanup-plan-review/20260528T120000Z/vendor-1883-cleanup-review.md`
- [ ] Review `deterministic-update-plan.json`
- [ ] Manual-review rows resolved or excluded

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_VENDOR_1883_CLEANUP=true
Approved by: Maysam Ebrahimi
UTC date: 05262026
```
