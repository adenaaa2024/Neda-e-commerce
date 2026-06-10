"use client";

import type { FinalizeValidationSummaryRow } from "@/lib/scanner/slip-shipment-validation-ui-helpers";

export function SlipShipmentValidationFinalizeSummary(props: { rows: FinalizeValidationSummaryRow[] }) {
  if (props.rows.length === 0) return null;
  return (
    <div
      className="operator-slip-validation-finalize-summary mt-3 rounded-xl border px-3 py-2.5"
      role="status"
      aria-label="Slip and shipment validation summary"
    >
      <p className="operator-slip-validation-finalize-summary__title text-center text-[10px] font-bold uppercase tracking-wide">
        Validation summary
      </p>
      <ul className="operator-slip-validation-finalize-summary__list mt-2 space-y-1">
        {props.rows.map((row) => (
          <li
            key={row.label}
            className="operator-slip-validation-finalize-summary__row flex items-center justify-between gap-2 text-[11px] font-semibold leading-snug"
          >
            <span className="min-w-0 text-left">{row.label}</span>
            <span className="shrink-0 font-black tabular-nums">{row.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
