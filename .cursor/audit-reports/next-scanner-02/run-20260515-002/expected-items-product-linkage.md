# Expected items (`expected_packages`) — product linkage

## Columns added (migration)

Nullable product + resolution metadata on `expected_packages` so expectation lines can carry a canonical product and deterministic resolution state independent of scanner receives.

## Application wiring

- Aggregation in `aggregateExpectedPackagesBySkuFnskuDisposition` merges `identifier_resolution_status`, `product_match_status`, and `product_review_required` across grouped rows (worst / OR semantics).
- `TrackingExpectedGroup` / `TrackingOperatorLine` carry these optional fields for UI.
- **Select compatibility:** default `EP_DETAIL_SELECT` unchanged. After migration, switch detail fetches to `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` (same file) so rows include DB-backed resolution fields.

## Display

- `ExpectedInventoryLineRow` in `app/scanner/operator-mobile/scan/page.tsx` renders resolution badges when the line carries merged status fields (typically after extended select is enabled).
