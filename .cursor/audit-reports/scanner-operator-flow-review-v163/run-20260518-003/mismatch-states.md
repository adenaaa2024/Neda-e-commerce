# Mismatch states

## Data model (unchanged)

Product mismatch is expressed on expectation / return rows as `product_match_status = 'mismatch'`, often with `product_review_required`, per NEXT-SCANNER-02/03 policy. This review does not alter that contract.

## Where mismatch appears in operator-mobile

### 1. Identification gate (pre-receive)

When `identifyGatePhase === "matched"` and rows carry linkage fields, a **Product resolution (expectation lines)** panel renders up to 12 lines with `scannerProductResolutionBadges` (Mismatch, Ambiguous, Unresolved, Manual override, Review).

Section at ~8379–8436 in `app/scanner/operator-mobile/scan/page.tsx`: **Product resolution (expectation lines)** list with `scannerProductResolutionBadges` per expectation row (max 12).

**Good:** Operators can see mismatch **before** Save & Start.

**Gap:** Lines without any resolution fields are hidden entirely—not shown as “OK.”

### 2. Pallet step — expected inventory rows

`ExpectedInventoryLineRow` uses `useScannerProductResolutionBadges` for worklist lines during pallet/tracking context.

### 3. Item phase — slip cards

Slip rows use **quantity-only** presentation (`itemInspectionSlipLinePresentation`): Awaiting / IN PROGRESS / RECEIVED / UNDER / OVER / UNEXPECTED at finalize.

`aggregateOperatorPackageItemRows` only aggregates **counts** by `slip_content_id`—not `product_match_status`.

`listOperatorPackageItemsForPackageAction` selects `return_items` fields without product linkage status chips.

**Gap:** Operators doing item scan **do not see product mismatch** on slip cards even if back office flagged lines earlier.

### 4. Order ID conflict (related, not product mismatch)

Separate UX for packing slip order id vs pallet order id (`PALLET_ORDER_ID_CONFLICT_*` strings)—distinct from SKU/FNSKU product mismatch.

### 5. Quantity mismatch at finalize

`isItemsQtyDiscrepancy` drives amber **Complete with Discrepancy** and warning copy in finalize modal—expected vs scanned **counts**, not catalog mismatch.

## Assessment

| Layer | Product mismatch | Qty mismatch |
|-------|------------------|--------------|
| Identify gate | Visible | Via inventory view totals |
| Item scan list | Not visible | Visible (progress + finalize) |
| Finalize | N/A | Visible |

**Stabilization is sufficient for gate; item phase is the main visibility gap.**
