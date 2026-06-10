/**
 * Phase 6D — Unified review engine types (box, pallet, shipment share one aggregation model).
 */

import type { ProductGrain, ProductGrainConfidence } from "@/lib/scanner/product-grain-match";

/** Shipment → Pallets → Boxes → Scans hierarchy scope. */
export type ReviewScopeKind = "box" | "pallet" | "shipment";

/** Canonical review buckets — all scopes map into these seven. */
export type UnifiedReviewBucket =
  | "complete"
  | "partial"
  | "missing"
  | "over"
  | "unexpected"
  | "slip_only"
  | "shipment_only";

export type ReviewGrainQuantities = {
  expected_qty: number;
  received_qty: number;
  missing_qty: number;
  over_qty: number;
  unexpected_qty: number;
  marked_missing_qty: number;
  /** Supporting breakdown (not separate buckets). */
  slip_qty: number;
  shipment_expected_qty: number;
  off_manifest_qty: number;
};

export type ReviewGrainLine = {
  grain_key: string;
  label: string | null;
  bucket: UnifiedReviewBucket;
  quantities: ReviewGrainQuantities;
  grain: ProductGrain;
  confidence: ProductGrainConfidence;
  slip_content_ids: string[];
  expected_package_ids: string[];
  return_item_ids: string[];
  package_ids: string[];
  sources: {
    has_slip: boolean;
    has_shipment: boolean;
    has_scan: boolean;
  };
  /** Optional pallet/box metadata — populated when scope spans packages. */
  build_sources: string[];
};

export type UnifiedReviewTotals = ReviewGrainQuantities;

export type UnifiedReviewResult = {
  scope: ReviewScopeKind;
  read_only: true;
  organization_id: string;
  store_id: string | null;
  package_ids: string[];
  pallet_id: string | null;
  tracking_numbers: string[];
  lines: ReviewGrainLine[];
  bucket_counts: Record<UnifiedReviewBucket, number>;
  totals: UnifiedReviewTotals;
};

/** Per-grain rollup input — loaders (box / pallet / shipment) produce these; engine classifies. */
export type ReviewGrainRollupInput = {
  grain_key: string;
  grain: ProductGrain;
  label: string | null;
  slip_qty: number;
  shipment_expected_qty: number;
  received_qty: number;
  off_manifest_qty: number;
  marked_missing_qty: number;
  remaining_missing_qty: number;
  slip_content_ids: string[];
  expected_package_ids: string[];
  return_item_ids: string[];
  package_ids: string[];
  build_sources: string[];
  has_slip: boolean;
  has_shipment: boolean;
  receive_finalized: boolean;
  /** When > 0, pallet adapter may map to legacy damaged bucket (not a unified bucket). */
  problem_qty?: number;
};

export type BuildUnifiedReviewInput = {
  scope: ReviewScopeKind;
  organization_id: string;
  store_id: string | null;
  package_ids: string[];
  pallet_id: string | null;
  tracking_numbers: string[];
  grains: ReviewGrainRollupInput[];
};
