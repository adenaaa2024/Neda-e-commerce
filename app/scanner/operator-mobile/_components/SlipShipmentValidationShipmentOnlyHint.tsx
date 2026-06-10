"use client";

import type { SlipShipmentValidationLine } from "@/lib/scanner/slip-shipment-validation-types";
import { SlipShipmentValidationChip } from "@/app/scanner/operator-mobile/_components/SlipShipmentValidationChip";

export function SlipShipmentValidationShipmentOnlyHint(props: { lines: SlipShipmentValidationLine[] }) {
  if (props.lines.length === 0) return null;
  return (
    <section
      className="operator-slip-validation-shipment-only-hint mb-2 rounded-lg border px-2 py-2"
      aria-label="Shipment manifest only items"
    >
      <p className="operator-slip-validation-shipment-only-hint__title text-[10px] font-bold leading-snug">
        On shipment manifest only
      </p>
      <p className="operator-slip-validation-shipment-only-hint__body mt-0.5 text-[9px] font-medium leading-snug">
        These units are expected from tracking/shipment data but do not appear on the packing slip for this box.
      </p>
      <ul className="operator-slip-validation-shipment-only-hint__list mt-1.5 space-y-1">
        {props.lines.map((line) => (
          <li
            key={line.grain_key}
            className="operator-slip-validation-shipment-only-hint__row flex min-w-0 items-center justify-between gap-2 rounded-md border px-2 py-1"
          >
            <span className="min-w-0 flex-1 truncate text-[9px] font-semibold leading-snug">
              {line.label?.trim() || "Unlabeled product"}
            </span>
            <span className="shrink-0 text-[9px] font-bold tabular-nums leading-none">
              exp {Math.max(0, line.shipment_expected_qty)}
            </span>
            <SlipShipmentValidationChip badge="shipment_only" />
          </li>
        ))}
      </ul>
    </section>
  );
}
