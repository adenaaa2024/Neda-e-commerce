/**
 * Phase 6D — Unified Review Engine
 * Shipment → Pallets → Boxes → Scans
 * Box / pallet / shipment reviews share one aggregation service.
 */

export type {
  BuildUnifiedReviewInput,
  ReviewGrainLine,
  ReviewGrainQuantities,
  ReviewGrainRollupInput,
  ReviewScopeKind,
  UnifiedReviewBucket,
  UnifiedReviewResult,
  UnifiedReviewTotals,
} from "@/lib/scanner/review-engine/review-engine-types";

export {
  classifyUnifiedReviewBucket,
  emptyUnifiedBucketCounts,
} from "@/lib/scanner/review-engine/review-engine-classify";

export {
  computeReviewGrainQuantities,
  emptyReviewQuantities,
  rollupReviewGrainInput,
  sumReviewQuantities,
} from "@/lib/scanner/review-engine/review-engine-quantities";

export {
  buildBoxScopeReview,
  buildPalletScopeReview,
  buildReviewGrainLine,
  buildShipmentScopeReview,
  buildUnifiedReviewResult,
} from "@/lib/scanner/review-engine/review-engine-aggregate";

export {
  reviewGrainLineToSlipShipmentValidationLine,
  unifiedBucketToBoxCloseReviewKey,
  unifiedBucketToPalletShipmentBucket,
  unifiedBucketToSlipShipmentBucket,
  unifiedReviewToSlipShipmentPreview,
} from "@/lib/scanner/review-engine/review-engine-adapters";
