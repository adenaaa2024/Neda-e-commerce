/**
 * Phase 6D — quantity rollup for unified review engine.
 */

import type { ReviewGrainQuantities, ReviewGrainRollupInput } from "@/lib/scanner/review-engine/review-engine-types";

export function emptyReviewQuantities(): ReviewGrainQuantities {
  return {
    expected_qty: 0,
    received_qty: 0,
    missing_qty: 0,
    over_qty: 0,
    unexpected_qty: 0,
    marked_missing_qty: 0,
    slip_qty: 0,
    shipment_expected_qty: 0,
    off_manifest_qty: 0,
  };
}

export function computeReviewGrainQuantities(input: {
  slip_qty: number;
  shipment_expected_qty: number;
  received_qty: number;
  off_manifest_qty: number;
  marked_missing_qty: number;
  remaining_missing_qty: number;
}): ReviewGrainQuantities {
  const slip_qty = Math.max(0, Math.floor(input.slip_qty));
  const shipment_expected_qty = Math.max(0, Math.floor(input.shipment_expected_qty));
  const received_qty = Math.max(0, Math.floor(input.received_qty));
  const off_manifest_qty = Math.max(0, Math.floor(input.off_manifest_qty));
  const marked_missing_qty = Math.max(0, Math.floor(input.marked_missing_qty));
  const expected_qty = Math.max(slip_qty, shipment_expected_qty);
  const remaining_missing_qty = Math.max(0, Math.floor(input.remaining_missing_qty));

  const over_qty = expected_qty > 0 && received_qty > expected_qty ? received_qty - expected_qty : 0;
  const missing_qty =
    remaining_missing_qty > 0
      ? remaining_missing_qty
      : expected_qty > received_qty
        ? expected_qty - received_qty - marked_missing_qty
        : 0;

  const hasExpectation = slip_qty > 0 || shipment_expected_qty > 0;
  const unexpected_qty =
    !hasExpectation && received_qty > 0
      ? received_qty
      : off_manifest_qty > 0 && expected_qty === 0 && slip_qty === 0
        ? off_manifest_qty
        : 0;

  return {
    expected_qty,
    received_qty,
    missing_qty: Math.max(0, missing_qty),
    over_qty,
    unexpected_qty,
    marked_missing_qty,
    slip_qty,
    shipment_expected_qty,
    off_manifest_qty,
  };
}

export function rollupReviewGrainInput(input: ReviewGrainRollupInput): ReviewGrainQuantities {
  return computeReviewGrainQuantities({
    slip_qty: input.slip_qty,
    shipment_expected_qty: input.shipment_expected_qty,
    received_qty: input.received_qty,
    off_manifest_qty: input.off_manifest_qty,
    marked_missing_qty: input.marked_missing_qty,
    remaining_missing_qty: input.remaining_missing_qty,
  });
}

export function sumReviewQuantities(lines: ReviewGrainQuantities[]): ReviewGrainQuantities {
  const totals = emptyReviewQuantities();
  for (const q of lines) {
    totals.expected_qty += q.expected_qty;
    totals.received_qty += q.received_qty;
    totals.missing_qty += q.missing_qty;
    totals.over_qty += q.over_qty;
    totals.unexpected_qty += q.unexpected_qty;
    totals.marked_missing_qty += q.marked_missing_qty;
    totals.slip_qty += q.slip_qty;
    totals.shipment_expected_qty += q.shipment_expected_qty;
    totals.off_manifest_qty += q.off_manifest_qty;
  }
  return totals;
}
