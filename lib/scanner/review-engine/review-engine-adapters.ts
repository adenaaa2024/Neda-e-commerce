/**
 * Phase 6D — map unified review buckets/lines to legacy preview consumers.
 */

import type { BoxCloseReviewBucketKey } from "@/lib/scanner/box-close-review";
import type { PalletShipmentReviewBucket } from "@/lib/scanner/pallet-shipment-review-types";
import type {
  SlipShipmentClaimMeaning,
  SlipShipmentValidationBucket,
  SlipShipmentValidationLine,
  SlipShipmentValidationPreview,
  SlipShipmentValidationSource,
  SlipShipmentValidationUiBadge,
} from "@/lib/scanner/slip-shipment-validation-types";
import type { ReviewGrainLine, UnifiedReviewBucket, UnifiedReviewResult } from "@/lib/scanner/review-engine/review-engine-types";

export function unifiedBucketToSlipShipmentBucket(
  unified: UnifiedReviewBucket,
  ctx: { has_slip: boolean; has_shipment: boolean; receive_finalized: boolean },
): SlipShipmentValidationBucket {
  switch (unified) {
    case "complete":
      return ctx.has_slip && ctx.has_shipment
        ? "shipment_and_slip_expected"
        : ctx.has_slip
          ? "slip_only"
          : "shipment_only";
    case "partial":
      return "pending_under_scanned";
    case "missing":
      return ctx.receive_finalized ? "final_missing_after_pallet_close" : "pending_under_scanned";
    case "over":
      return "over_scanned";
    case "unexpected":
      return "scanned_off_manifest";
    case "slip_only":
      return "slip_only";
    case "shipment_only":
      return "shipment_only";
    default:
      return "scanned_off_manifest";
  }
}

export function unifiedBucketToPalletShipmentBucket(
  unified: UnifiedReviewBucket,
  ctx: { problem_qty: number; has_slip: boolean; has_shipment: boolean },
): PalletShipmentReviewBucket {
  if (ctx.problem_qty > 0) return "damaged_or_problem_items";

  switch (unified) {
    case "complete":
      return "expected_received_complete";
    case "partial":
      return "expected_under_received";
    case "missing":
      return "expected_under_received";
    case "over":
      return "expected_over_received";
    case "unexpected":
      return "scanned_off_manifest";
    case "slip_only":
      return "slip_only_evidence";
    case "shipment_only":
      return "shipment_only_expected";
    default:
      return "pending_review";
  }
}

export function unifiedBucketToBoxCloseReviewKey(unified: UnifiedReviewBucket): BoxCloseReviewBucketKey | null {
  switch (unified) {
    case "complete":
      return "received_complete";
    case "partial":
      return "pending_under_scanned";
    case "missing":
      return "pending_under_scanned";
    case "over":
      return "over_scanned";
    case "unexpected":
      return "scanned_off_manifest";
    case "slip_only":
      return "slip_only";
    case "shipment_only":
      return "shipment_only";
    default:
      return null;
  }
}

function uiBadgeForSlipBucket(bucket: SlipShipmentValidationBucket): SlipShipmentValidationUiBadge {
  switch (bucket) {
    case "shipment_and_slip_expected":
      return "confirmed";
    case "slip_only":
      return "slip_only";
    case "shipment_only":
      return "shipment_only";
    case "scanned_off_manifest":
      return "off_manifest";
    case "over_scanned":
      return "over_scanned";
    case "pending_under_scanned":
      return "pending";
    case "final_missing_after_pallet_close":
      return "missing_finalized";
    default:
      return "unresolved";
  }
}

function claimMeaningForSlipBucket(bucket: SlipShipmentValidationBucket): SlipShipmentClaimMeaning {
  switch (bucket) {
    case "shipment_and_slip_expected":
      return "shipment_slip_aligned";
    case "slip_only":
      return "slip_without_shipment_manifest";
    case "shipment_only":
      return "shipment_without_slip_line";
    case "scanned_off_manifest":
      return "warehouse_extra_unit";
    case "over_scanned":
      return "quantity_over_received";
    case "pending_under_scanned":
      return "quantity_short_pending";
    case "final_missing_after_pallet_close":
      return "shortage_locked_after_finalize";
    default:
      return "none";
  }
}

function sourcesPresent(line: ReviewGrainLine): SlipShipmentValidationSource[] {
  const out: SlipShipmentValidationSource[] = [];
  if (line.quantities.shipment_expected_qty > 0) out.push("shipment_expected");
  if (line.quantities.slip_qty > 0) out.push("packing_slip");
  if (line.quantities.received_qty > 0) out.push("operator_scan");
  return out;
}

export function reviewGrainLineToSlipShipmentValidationLine(
  line: ReviewGrainLine,
  receiveFinalized: boolean,
): SlipShipmentValidationLine {
  const bucket = unifiedBucketToSlipShipmentBucket(line.bucket, {
    has_slip: line.sources.has_slip,
    has_shipment: line.sources.has_shipment,
    receive_finalized: receiveFinalized,
  });

  return {
    grain_key: line.grain_key,
    bucket,
    grain: line.grain,
    confidence: line.confidence,
    sources_present: sourcesPresent(line),
    slip_qty: line.quantities.slip_qty,
    shipment_expected_qty: line.quantities.shipment_expected_qty,
    scanned_qty: line.quantities.received_qty,
    off_manifest_scanned_qty: line.quantities.off_manifest_qty,
    recorded_missing_qty: line.quantities.marked_missing_qty,
    remaining_missing_qty: line.quantities.missing_qty,
    delta_scanned_vs_expected: line.quantities.received_qty - line.quantities.expected_qty,
    ui_badge: uiBadgeForSlipBucket(bucket),
    claim_meaning: claimMeaningForSlipBucket(bucket),
    slip_content_ids: line.slip_content_ids,
    expected_package_ids: line.expected_package_ids,
    return_item_ids: line.return_item_ids,
    build_sources: line.build_sources,
    label: line.label,
  };
}

export function unifiedReviewToSlipShipmentPreview(
  review: UnifiedReviewResult,
  meta: {
    package_id: string;
    package_code: string | null;
    slip_code: string | null;
    tracking_number: string | null;
    receive_state: "open" | "finalized";
  },
): SlipShipmentValidationPreview {
  const receiveFinalized = meta.receive_state === "finalized";
  const lines = review.lines.map((l) => reviewGrainLineToSlipShipmentValidationLine(l, receiveFinalized));

  const bucket_counts = {
    shipment_and_slip_expected: 0,
    slip_only: 0,
    shipment_only: 0,
    scanned_off_manifest: 0,
    over_scanned: 0,
    pending_under_scanned: 0,
    final_missing_after_pallet_close: 0,
  };
  for (const line of lines) {
    bucket_counts[line.bucket] += 1;
  }

  return {
    package_id: meta.package_id,
    organization_id: review.organization_id,
    store_id: review.store_id,
    tracking_number: meta.tracking_number,
    slip_code: meta.slip_code,
    package_code: meta.package_code,
    receive_state: meta.receive_state,
    read_only: true,
    lines,
    bucket_counts,
    totals: {
      slip_units: review.totals.slip_qty,
      shipment_expected_units: review.totals.shipment_expected_qty,
      scanned_units: review.totals.received_qty,
      off_manifest_units: review.totals.off_manifest_qty,
    },
  };
}
