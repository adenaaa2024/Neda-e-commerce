/**
 * Phase 6F-B — read-only slip vs shipment vs scan validation preview types.
 */

import type { ProductGrain, ProductGrainConfidence } from "@/lib/scanner/product-grain-match";

export type SlipShipmentValidationBucket =
  | "shipment_and_slip_expected"
  | "slip_only"
  | "shipment_only"
  | "scanned_off_manifest"
  | "over_scanned"
  | "pending_under_scanned"
  | "final_missing_after_pallet_close";

export type SlipShipmentValidationSource =
  | "shipment_expected"
  | "packing_slip"
  | "operator_scan";

export type SlipShipmentValidationUiBadge =
  | "confirmed"
  | "slip_only"
  | "shipment_only"
  | "off_manifest"
  | "over_scanned"
  | "pending"
  | "missing_finalized"
  | "unresolved";

export type SlipShipmentClaimMeaning =
  | "none"
  | "shipment_slip_aligned"
  | "slip_without_shipment_manifest"
  | "shipment_without_slip_line"
  | "warehouse_extra_unit"
  | "quantity_over_received"
  | "quantity_short_pending"
  | "shortage_locked_after_finalize";

export type SlipShipmentValidationLine = {
  grain_key: string;
  bucket: SlipShipmentValidationBucket;
  grain: ProductGrain;
  confidence: ProductGrainConfidence;
  sources_present: SlipShipmentValidationSource[];
  slip_qty: number;
  shipment_expected_qty: number;
  scanned_qty: number;
  off_manifest_scanned_qty: number;
  recorded_missing_qty: number;
  remaining_missing_qty: number;
  delta_scanned_vs_expected: number;
  ui_badge: SlipShipmentValidationUiBadge;
  claim_meaning: SlipShipmentClaimMeaning;
  slip_content_ids: string[];
  expected_package_ids: string[];
  return_item_ids: string[];
  build_sources: string[];
  label: string | null;
};

export type SlipShipmentValidationPreview = {
  package_id: string;
  organization_id: string;
  store_id: string | null;
  tracking_number: string | null;
  slip_code: string | null;
  package_code: string | null;
  receive_state: "open" | "finalized";
  read_only: true;
  lines: SlipShipmentValidationLine[];
  bucket_counts: Record<SlipShipmentValidationBucket, number>;
  totals: {
    slip_units: number;
    shipment_expected_units: number;
    scanned_units: number;
    off_manifest_units: number;
  };
};
