/**
 * Phase 6F — UI helpers for slip/shipment validation preview (read-only chips + summaries).
 */

import { productGrainKey, slipRowToProductGrain } from "@/lib/scanner/product-grain-match";
import type {
  SlipShipmentValidationLine,
  SlipShipmentValidationPreview,
  SlipShipmentValidationUiBadge,
} from "@/lib/scanner/slip-shipment-validation-types";

export function validationChipLabel(badge: SlipShipmentValidationUiBadge): string {
  switch (badge) {
    case "confirmed":
      return "Confirmed";
    case "slip_only":
      return "Slip only";
    case "shipment_only":
      return "Shipment only";
    case "off_manifest":
      return "Off manifest";
    case "over_scanned":
      return "Over";
    case "pending":
      return "Pending";
    case "missing_finalized":
      return "Final missing";
    case "unresolved":
    default:
      return "Unresolved";
  }
}

/** Additive chips only — row/card colors and existing pills stay authoritative. */
export function shouldShowValidationChipOnRow(
  badge: SlipShipmentValidationUiBadge,
  receiveState: "open" | "finalized",
): boolean {
  if (badge === "missing_finalized" && receiveState === "open") return false;
  if (badge === "off_manifest" || badge === "over_scanned" || badge === "pending") return false;
  return badge === "confirmed" || badge === "slip_only" || badge === "shipment_only" || badge === "unresolved";
}

export function buildValidationLineBySlipId(
  preview: SlipShipmentValidationPreview,
): Map<string, SlipShipmentValidationLine> {
  const map = new Map<string, SlipShipmentValidationLine>();
  for (const line of preview.lines) {
    for (const slipId of line.slip_content_ids) {
      map.set(slipId, line);
    }
  }
  return map;
}

export function resolveValidationLineForSlipRow(
  preview: SlipShipmentValidationPreview | null,
  slipRow: Record<string, unknown>,
  slipId: string | null,
  bySlipId?: Map<string, SlipShipmentValidationLine>,
): SlipShipmentValidationLine | null {
  if (!preview) return null;
  const lookup = bySlipId ?? buildValidationLineBySlipId(preview);
  if (slipId && lookup.has(slipId)) return lookup.get(slipId)!;
  const grainKey = productGrainKey(slipRowToProductGrain(slipRow));
  if (!grainKey) return null;
  return preview.lines.find((line) => line.grain_key === grainKey) ?? null;
}

export function shipmentOnlyValidationLines(
  preview: SlipShipmentValidationPreview,
): SlipShipmentValidationLine[] {
  return preview.lines.filter((line) => line.bucket === "shipment_only");
}

export type FinalizeValidationSummaryRow = {
  label: string;
  count: number;
};

export function buildFinalizeValidationSummary(
  preview: SlipShipmentValidationPreview | null,
): FinalizeValidationSummaryRow[] {
  if (!preview) return [];
  const rows: FinalizeValidationSummaryRow[] = [];
  const push = (label: string, count: number) => {
    if (count > 0) rows.push({ label, count });
  };
  push("Confirmed (slip + shipment)", preview.bucket_counts.shipment_and_slip_expected);
  push("Slip only", preview.bucket_counts.slip_only);
  push("Shipment only", preview.bucket_counts.shipment_only);
  push("Off manifest", preview.bucket_counts.scanned_off_manifest);
  push("Over scanned", preview.bucket_counts.over_scanned);
  push("Pending", preview.bucket_counts.pending_under_scanned);
  if (preview.receive_state === "finalized") {
    push("Final missing", preview.bucket_counts.final_missing_after_pallet_close);
  }
  return rows;
}
