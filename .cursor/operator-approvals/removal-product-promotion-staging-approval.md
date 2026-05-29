# Removal product promotion — staging operator approval

**Scope:** Governed `products` INSERT + `product_identifier_map` INSERT for **Amazon removal report evidence-backed** candidates only (`eiqfaapyumhixxoeltgu`).

**Default:** not approved.

| Field | Value |
|-------|--------|
| Plan review | `.cursor/audit-reports/removal-product-promotion-plan/20260528T160000Z/` |
| Promote-ready rows | **0** |

```text
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_PRODUCT_PROMOTION=false
```

## Allowed when approved

| Allowed | Forbidden |
|---------|-----------|
| Staging product+map insert for `promote-ready-candidates.json` only | Blind create from title-only |
| Before/after audit JSON | Production / original |
| Rollback from execute preimage | UNKNOW / ASIN-in-fnsku rows |
| | Amazon API in same execute (separate approval) |

## Preconditions

- [ ] Review `product-promotion-plan.md`
- [ ] Review `promote-ready-candidates.json`
- [ ] `needs-catalog-evidence.json` handled via Catalog GET wave first

## Sign-off

```
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_PRODUCT_PROMOTION=false
Approved by:
UTC date:
```
