# Removal Expected Packages Resolver Backfill — Approval

Supabase project ref/name: eiqfaapyumhixxoeltgu
Environment: staging
Approved by:
Approved at UTC:

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL=true
```

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
- [ ] No Amazon API / AI during backfill
- [ ] No changes to `expected_scan_quantity`, `build_source`, or shipment join keys

## Preconditions

| Item | Confirmed (Y/N) |
|------|-----------------|
| Removal rebuild verify PASS (`rebuild_valid=yes`) | |
| Allocation mismatch blockers cleared | |
| Dry-run after fix reviewed | |

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL=true
Approved by: Maysam Ebrahimi
UTC date: 05272026
Max rows per execute batch (default 500): 500
Notes:
```
