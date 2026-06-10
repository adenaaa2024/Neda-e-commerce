"use client";

import type { SlipShipmentValidationUiBadge } from "@/lib/scanner/slip-shipment-validation-types";
import { validationChipLabel } from "@/lib/scanner/slip-shipment-validation-ui-helpers";

const CHIP_MODIFIER: Partial<Record<SlipShipmentValidationUiBadge, string>> = {
  confirmed: "operator-slip-validation-chip--confirmed",
  slip_only: "operator-slip-validation-chip--slip-only",
  shipment_only: "operator-slip-validation-chip--shipment-only",
  unresolved: "operator-slip-validation-chip--unresolved",
};

export function SlipShipmentValidationChip(props: { badge: SlipShipmentValidationUiBadge }) {
  const modifier = CHIP_MODIFIER[props.badge];
  if (!modifier) return null;
  return (
    <span
      className={`operator-slip-validation-chip shrink-0 rounded border px-1 py-0.5 text-[8px] font-bold uppercase leading-none tracking-wide ${modifier}`}
      title={validationChipLabel(props.badge)}
    >
      {validationChipLabel(props.badge)}
    </span>
  );
}
