/**
 * Phase 6D — unified review aggregation service.
 * Box, pallet, and shipment loaders feed grain rollups; this engine classifies and totals.
 */

import { productGrainConfidence } from "@/lib/scanner/product-grain-match";
import { classifyUnifiedReviewBucket, emptyUnifiedBucketCounts } from "@/lib/scanner/review-engine/review-engine-classify";
import { rollupReviewGrainInput, sumReviewQuantities } from "@/lib/scanner/review-engine/review-engine-quantities";
import type {
  BuildUnifiedReviewInput,
  ReviewGrainLine,
  ReviewGrainRollupInput,
  UnifiedReviewResult,
} from "@/lib/scanner/review-engine/review-engine-types";

export function buildReviewGrainLine(input: ReviewGrainRollupInput): ReviewGrainLine {
  const quantities = rollupReviewGrainInput(input);
  const bucket = classifyUnifiedReviewBucket({
    quantities,
    has_slip: input.has_slip,
    has_shipment: input.has_shipment,
    receive_finalized: input.receive_finalized,
  });

  return {
    grain_key: input.grain_key,
    label: input.label,
    bucket,
    quantities,
    grain: input.grain,
    confidence: productGrainConfidence(input.grain),
    slip_content_ids: input.slip_content_ids,
    expected_package_ids: input.expected_package_ids,
    return_item_ids: input.return_item_ids,
    package_ids: input.package_ids,
    sources: {
      has_slip: input.has_slip,
      has_shipment: input.has_shipment,
      has_scan: input.received_qty > 0,
    },
    build_sources: input.build_sources,
  };
}

export function buildUnifiedReviewResult(input: BuildUnifiedReviewInput): UnifiedReviewResult {
  const lines = input.grains.map(buildReviewGrainLine);
  lines.sort((a, b) => (a.label ?? a.grain_key).localeCompare(b.label ?? b.grain_key));

  const bucket_counts = emptyUnifiedBucketCounts();
  for (const line of lines) {
    bucket_counts[line.bucket] += 1;
  }

  return {
    scope: input.scope,
    read_only: true,
    organization_id: input.organization_id,
    store_id: input.store_id,
    package_ids: input.package_ids,
    pallet_id: input.pallet_id,
    tracking_numbers: input.tracking_numbers,
    lines,
    bucket_counts,
    totals: sumReviewQuantities(lines.map((l) => l.quantities)),
  };
}

/** Box scope — single package (current box only). */
export function buildBoxScopeReview(input: Omit<BuildUnifiedReviewInput, "scope">): UnifiedReviewResult {
  return buildUnifiedReviewResult({ ...input, scope: "box" });
}

/** Pallet scope — all boxes on one pallet. */
export function buildPalletScopeReview(input: Omit<BuildUnifiedReviewInput, "scope">): UnifiedReviewResult {
  return buildUnifiedReviewResult({ ...input, scope: "pallet" });
}

/** Shipment scope — all pallets and boxes for tracking number(s). */
export function buildShipmentScopeReview(input: Omit<BuildUnifiedReviewInput, "scope">): UnifiedReviewResult {
  return buildUnifiedReviewResult({ ...input, scope: "shipment" });
}
