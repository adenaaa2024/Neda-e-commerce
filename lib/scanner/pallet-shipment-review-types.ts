/**
 * Phase 6E-A — read-only pallet/shipment review preview types (no close, no claims).
 */

import type { ProductGrain, ProductGrainConfidence } from "@/lib/scanner/product-grain-match";

export type PalletShipmentReviewBucket =
  | "expected_received_complete"
  | "expected_under_received"
  | "expected_over_received"
  | "scanned_off_manifest"
  | "slip_only_evidence"
  | "shipment_only_expected"
  | "damaged_or_problem_items"
  | "pending_review";

export type PalletShipmentReviewScopeKind = "pallet" | "shipment_tracking";

export type PalletShipmentReviewClaimMeaning =
  | "no_claim_delta"
  | "potential_shortage_claim_at_close"
  | "no_excess_claim"
  | "physical_only_no_auto_claim"
  | "excluded_from_claim_pool"
  | "included_in_expected_pool"
  | "damage_claim_candidate"
  | "no_claim_until_review";

export type PalletShipmentReviewSuggestedAction =
  | "none"
  | "confirm_shortage_at_close"
  | "review_excess_scans"
  | "verify_off_manifest_identity"
  | "slip_evidence_triage"
  | "check_other_boxes_on_shipment"
  | "review_damage_evidence"
  | "resolve_linkage_or_notes";

export type PalletShipmentReviewPackageRef = {
  package_id: string;
  package_code: string | null;
  id_slip_contents: string | null;
  tracking_number: string | null;
  receive_state: "open" | "finalized" | "unknown";
};

export type PalletShipmentReviewLine = {
  grain_key: string;
  bucket: PalletShipmentReviewBucket;
  grain: ProductGrain;
  confidence: ProductGrainConfidence;
  resolved_product_id: string | null;
  identifiers: {
    upc: string | null;
    sku: string | null;
    fnsku: string | null;
    asin: string | null;
  };
  expected_qty: number;
  slip_qty: number;
  scanned_qty: number;
  delta_qty: number;
  off_manifest_scanned_qty: number;
  operator_note_missing_qty: number;
  problem_item_qty: number;
  packages: PalletShipmentReviewPackageRef[];
  evidence_photo_count: number;
  suggested_review_action: PalletShipmentReviewSuggestedAction;
  claim_meaning: PalletShipmentReviewClaimMeaning;
  label: string | null;
  slip_content_ids: string[];
  expected_package_ids: string[];
  return_item_ids: string[];
};

export type PalletShipmentReviewPreview = {
  phase: "6E-A";
  read_only: true;
  scope_kind: PalletShipmentReviewScopeKind;
  organization_id: string;
  store_id: string;
  pallet_id: string | null;
  tracking_number: string | null;
  tracking_numbers: string[];
  package_count: number;
  lines: PalletShipmentReviewLine[];
  bucket_counts: Record<PalletShipmentReviewBucket, number>;
  totals: {
    shipment_expected_units: number;
    slip_units: number;
    scanned_units: number;
    off_manifest_units: number;
    operator_note_missing_units: number;
    problem_item_units: number;
  };
};

export type PalletShipmentReviewScopeInput = {
  organizationId: string;
  storeId: string;
  palletId?: string | null;
  trackingNumber?: string | null;
};
