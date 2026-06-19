"use client";

import { ClipboardList } from "lucide-react";

import {
  summarizeShipmentExpectedContext,
  type ShipmentExpectedContext,
} from "@/lib/scanner/shipment-expected-context";

type ShipmentExpectedCompactCardProps = {
  context: ShipmentExpectedContext;
  onViewExpected: () => void;
  variant?: "hub" | "inline" | "box_info";
};

function shipmentMetaLine(context: ShipmentExpectedContext): string {
  const parts = [
    context.carrier?.trim() || null,
    context.tracking_number?.trim() || null,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function ShipmentExpectedCompactCard(props: ShipmentExpectedCompactCardProps) {
  const { context, onViewExpected, variant = "hub" } = props;
  const summary = summarizeShipmentExpectedContext(context);
  const meta = shipmentMetaLine(context);
  const compact = variant === "inline" || variant === "box_info";

  return (
    <section
      className={`rounded-xl border border-sky-500/25 bg-sky-950/20 ${
        compact ? "px-2.5 py-2" : "p-3"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <ClipboardList className="h-3.5 w-3.5 shrink-0 text-sky-200/90" strokeWidth={2.25} aria-hidden />
            <p className="text-[11px] font-bold uppercase tracking-wide text-sky-100/90">Shipment Expected</p>
          </div>
          {meta ? (
            <p className="mt-1 truncate font-mono text-[11px] font-semibold leading-snug text-slate-200">{meta}</p>
          ) : null}
          <p className="mt-1 text-[12px] font-semibold leading-snug text-white">
            {context.expected_item_types} item type{context.expected_item_types !== 1 ? "s" : ""} ·{" "}
            {context.expected_total_units} units
          </p>
          <p className="mt-0.5 text-[11px] font-semibold tabular-nums text-sky-100/90">
            Scanned {summary.scannedUnits} / {context.expected_total_units}
          </p>
        </div>
        <button
          type="button"
          onClick={onViewExpected}
          className={`shrink-0 rounded-lg border border-sky-400/35 bg-sky-900/40 font-bold text-sky-50 transition active:scale-[0.98] ${
            compact ? "px-2 py-1 text-[10px]" : "px-2.5 py-1.5 text-[11px]"
          }`}
        >
          View Expected
        </button>
      </div>
    </section>
  );
}
