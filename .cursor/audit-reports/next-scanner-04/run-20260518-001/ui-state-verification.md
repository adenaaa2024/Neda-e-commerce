# UI state verification (NEXT-SCANNER-04)

## Live browser QA

**Not run** — extended selects fail on linked DB; UI would not receive linkage columns.

## Static verification (code review — pass)

### Expected package / scan identification

- `lib/scanner/product-resolution-badges.ts` — chips for `mismatch`, `ambiguous`, `unresolved`, `manual_override`, review required.
- `aggregateExpectedPackagesBySkuFnskuDisposition` merges groups; worst-case `product_match_status` / `product_review_required` wins (covered by `scripts/scanner-resolution-check.ts`).

### Return items drawer

`app/returns/_components.tsx`:

- `scannerProductNeedsAttention` when `product_review_required`, `mismatch`, `unresolved`/`ambiguous`, or `manual_override` source.
- Review panel + manual override controls load same-SKU products from `products` (org + store scoped).
- Badges driven from `scannerProductResolutionBadges(record)`.

### Mismatch / unresolved display

| State | UI signal |
|-------|-----------|
| `product_match_status: mismatch` | Mismatch badge; `product_review_required` |
| `identifier_resolution_status: ambiguous` | Ambiguous badge |
| `identifier_resolution_status: unresolved` | Unresolved badge |
| `identifier_resolution_source: manual_override` | Manual override badge |

## Post-migration manual QA

1. Operator scan → identification gate with EP rows that have linkage populated → chips visible.
2. Returns → item drawer on mismatch/unresolved line → review panel + override round-trip.
3. List row refresh after override shows updated linkage fields.
