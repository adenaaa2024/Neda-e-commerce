# Removal missing products — Amazon evidence dry-run

Supabase project ref/name: eiqfaapyumhixxoeltgu
Environment: staging
Approved by:
Approved at UTC:

APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_MISSING_PRODUCTS_AMAZON_EVIDENCE=true

APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_MISSING_PRODUCTS_CATALOG_EVIDENCE=true

## Scope

- Staging only (`eiqfaapyumhixxoeltgu`)
- Evidence queue rows: **24** (from removal resolver missing_product_needs_evidence)
- API-ready rows (asin_ready + fnsku_ready): **10**
- Plan: `.cursor/audit-reports/pc03d-evidence-queue-from-removal-resolver/20260528T010000Z/`
- Mode: SP-API catalog / FBA inventory evidence dry-run only
- No product create, no map insert, no expected_packages update

## Explicit exclusions

- [ ] No production / original (`kxsvedvpjldygtdbylsy`)
- [ ] No DB writes in dry-run
- [ ] No product auto-create
- [ ] No `product_identifier_map.insert`

## Preconditions

| Item | Confirmed (Y/N) |
|------|-----------------|
| Removal resolver execute reviewed: `.cursor/audit-reports/removal-expected-packages-resolver-backfill-execute/20260527T230000Z` | |
| Junk identifier rows excluded or source-repaired first | |
| SP-API credentials present on staging store | |

## Sign-off

```
Environment: STAGING ONLY
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_MISSING_PRODUCTS_AMAZON_EVIDENCE=true

APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_MISSING_PRODUCTS_CATALOG_EVIDENCE=true
Approved by: Maysam Ebrahimi
UTC date: 05272026
Max API calls:
Notes:
```
