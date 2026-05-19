# Extended select wiring

## `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT`

Wired into:

- `fetchExpectedPackageDetailRowsByIds` — `.select(EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT)` (was `EP_DETAIL_SELECT`).
- `fetchExpectedPackageDetailRowsForParent` — both the tracking branch and the pallet multi-tracking branch use `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` (was `EP_DETAIL_SELECT`).

## Tracking / pallet snapshots

New export: `EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT` (base `EP_SELECT` + linkage columns).

Wired into:

- `loadTrackingExpectationSnapshot` — passes this select into `fetchExpectedPackagesForTracking` so aggregated `TrackingOperatorLine` rows receive `identifier_resolution_status`, `product_match_status`, and `product_review_required` from raw `expected_packages` rows.
- `loadPalletExpectationSnapshot` — passes the same into `fetchExpectedPackagesForTrackingNumbers`.

**Note:** `fetchExpectedPackagesForTracking` default remains `EP_SELECT` for callers that only need lightweight rows (e.g. barcode resolve first hit).

## `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT`

Wired into all server `return_items` list reads in `app/returns/actions.ts` that previously used `RETURN_LIST_SELECT`:

- `listReturnsByPackage`
- `listClaimPipelineReturns`
- `listReturns`
- `listReturnsByPallet`

`insertReturn` / `updateReturn` continue to use `RETURN_SELECT` (`*`), which already returns linkage columns when present.

## Scanner reads

Client scanner flows that call `fetchExpectedPackageDetailRowsByIds` / `fetchExpectedPackageDetailRowsForParent` inherit extended EP columns automatically (identify gate + items phase hydration).
