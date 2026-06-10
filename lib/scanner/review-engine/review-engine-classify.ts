/**
 * Phase 6D — unified bucket classification (single ruleset for box / pallet / shipment).
 */

import type {
  ReviewGrainQuantities,
  UnifiedReviewBucket,
} from "@/lib/scanner/review-engine/review-engine-types";

export function emptyUnifiedBucketCounts(): Record<UnifiedReviewBucket, number> {
  return {
    complete: 0,
    partial: 0,
    missing: 0,
    over: 0,
    unexpected: 0,
    slip_only: 0,
    shipment_only: 0,
  };
}

export function classifyUnifiedReviewBucket(input: {
  quantities: ReviewGrainQuantities;
  has_slip: boolean;
  has_shipment: boolean;
  receive_finalized: boolean;
}): UnifiedReviewBucket {
  const { quantities, has_slip, has_shipment, receive_finalized } = input;
  const hasExpectation = has_slip || has_shipment;
  const expectedCap = quantities.expected_qty;

  if (
    receive_finalized &&
    quantities.missing_qty > 0 &&
    (has_slip || quantities.slip_qty > 0)
  ) {
    return "missing";
  }

  if (quantities.unexpected_qty > 0 && !hasExpectation) {
    return "unexpected";
  }

  if (hasExpectation) {
    if (has_slip && has_shipment) {
      if (quantities.over_qty > 0) return "over";
      if (quantities.missing_qty > 0 || quantities.received_qty < expectedCap) return "partial";
      return "complete";
    }

    if (has_slip && !has_shipment) {
      if (quantities.off_manifest_qty > 0 && quantities.received_qty > quantities.slip_qty) {
        return "over";
      }
      if (quantities.missing_qty > 0 || quantities.received_qty < quantities.slip_qty) {
        return "partial";
      }
      return "slip_only";
    }

    if (!has_slip && has_shipment) {
      if (quantities.over_qty > 0) return "over";
      if (quantities.missing_qty > 0 || quantities.received_qty < quantities.shipment_expected_qty) {
        return "partial";
      }
      if (quantities.received_qty === quantities.shipment_expected_qty && expectedCap > 0) {
        return "complete";
      }
      return "shipment_only";
    }
  }

  if (quantities.off_manifest_qty > 0 || (quantities.received_qty > 0 && !hasExpectation)) {
    return "unexpected";
  }

  if (quantities.over_qty > 0 && expectedCap > 0) {
    return "over";
  }

  if (expectedCap > 0 && quantities.received_qty < expectedCap) {
    return quantities.missing_qty > 0 && receive_finalized ? "missing" : "partial";
  }

  if (has_slip && has_shipment) return "complete";
  if (has_slip) return "slip_only";
  if (has_shipment) return "shipment_only";
  return "unexpected";
}
