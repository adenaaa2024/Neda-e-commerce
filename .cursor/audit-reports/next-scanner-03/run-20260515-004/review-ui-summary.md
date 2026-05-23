# Review UI summary

## Operator mobile — expectation inventory lines

Existing `ExpectedInventoryLineRow` already rendered `useScannerProductResolutionBadges` from `TrackingOperatorLine`. Extended EP snapshot selects now populate those fields from the database when migration columns exist.

## Identification gate (matched)

When at least one `identifyGateRows` expectation row carries any of:

- `identifier_resolution_status`
- `product_match_status`
- `product_review_required`
- `identifier_resolution_source`

…the gate shows a **“Product resolution (expectation lines)”** list: SKU/FNSKU/disposition label plus chips from `scannerProductResolutionBadges` (including manual override when `identifier_resolution_source === "manual_override"`).

## Returns item drawer

`ItemDrawerContent` shows an amber **“Product linkage review”** panel when:

- `product_review_required` is true, or
- `product_match_status` is `mismatch`, or
- `identifier_resolution_status` is `unresolved` or `ambiguous`, or
- `identifier_resolution_source` is `manual_override`.

The panel displays the same badge set, explanatory copy, optional catalog matches (same SKU in store), optional UUID field, and **Apply manual product link** (server action).

## Badge hook

`useScannerProductResolutionBadges` accepts an optional fourth argument `identifierResolutionSource` for future row-level EP UI; inventory lines still call it with three arguments (source is not aggregated on `TrackingOperatorLine`).
