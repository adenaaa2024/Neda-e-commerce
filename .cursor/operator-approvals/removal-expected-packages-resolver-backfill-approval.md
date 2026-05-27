# Removal Expected Packages Resolver Backfill — Approval

Supabase project ref/name: eiqfaapyumhixxoeltgu
Environment: staging
Approved by:
Approved at UTC:

APPROVED_TO_RUN_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL_STAGING=false

## Scope

- Staging only (`eiqfaapyumhixxoeltgu`)
- Backfill `public.expected_packages` resolver columns for **derived** rows (`build_source IN ('detail_shipment', 'detail_remainder')`)
- Reuse `resolveScannerProductIdentifiers` via `lib/removal/resolve-expected-package-product.ts`
- Deterministic tiers only: FNSKU → ASIN → SKU → UPC (`product_identifier_map`)

## Explicit exclusions

- [ ] No production writes
- [ ] No `products.insert` / product auto-create
- [ ] No `product_identifier_map.insert`
- [ ] No title-only promotion
- [ ] No `package_items` DDL or data
- [ ] No Amazon API / AI
- [ ] No changes to `expected_scan_quantity`, `build_source`, or shipment join keys

## Preconditions

| Item | Confirmed (Y/N) |
|------|-----------------|
| Wire plan reviewed: `.cursor/audit-reports/removal-product-resolver-wire-plan/` | |
| Dry-run preimage written | |
| Batch size / statement timeout plan accepted | |

## Signoff

```
Environment: STAGING ONLY
Status: NOT APPROVED
Approved by:
UTC date:
Max rows per execute batch (default 500):
Notes:
```
