"use client";

import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import {
  deriveShipmentExpectedLineStatus,
  formatShipmentExpectedLineStatusLabel,
  summarizeShipmentExpectedContext,
  type ShipmentExpectedContext,
  type ShipmentExpectedLineStatus,
} from "@/lib/scanner/shipment-expected-context";

type ShipmentExpectedReviewModalProps = {
  open: boolean;
  context: ShipmentExpectedContext;
  atFinalReview?: boolean;
  onClose: () => void;
};

const STATUS_TONE: Record<ShipmentExpectedLineStatus, string> = {
  pending: "text-slate-300",
  partial: "text-amber-200",
  received: "text-emerald-200",
  over: "text-orange-200",
  missing: "text-rose-200",
};

function identifierLine(line: {
  fnsku: string | null;
  sku: string | null;
  asin: string | null;
  upc: string | null;
}): string | null {
  const parts = [
    line.fnsku ? `FNSKU ${line.fnsku}` : null,
    line.sku ? `SKU ${line.sku}` : null,
    line.asin ? `ASIN ${line.asin}` : null,
    line.upc ? `UPC ${line.upc}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function ShipmentExpectedReviewModal(props: ShipmentExpectedReviewModalProps) {
  const { open, context, atFinalReview = false, onClose } = props;

  const summary = useMemo(() => summarizeShipmentExpectedContext(context), [context]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="operator-shipment-flow-modal fixed inset-0 z-[145] flex items-end justify-center sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shipment-expected-review-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/55"
        aria-label="Close expected shipment review"
        onClick={onClose}
      />
      <div className="operator-shipment-flow-modal__panel relative flex max-h-[calc(100dvh-16px)] w-full max-w-md flex-col overflow-hidden rounded-t-[24px] border p-4 sm:rounded-[24px]">
        <header className="shrink-0">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p id="shipment-expected-review-title" className="operator-shipment-flow-modal__title text-[17px] font-black leading-snug">
                Expected Shipment
              </p>
              <p className="operator-shipment-flow-modal__body mt-1 text-[12px] font-semibold leading-snug">
                Compare manifest expectations against scanned units.
              </p>
            </div>
            <button
              type="button"
              className="rounded-lg border border-white/10 p-1.5 text-white/80 transition active:scale-95"
              aria-label="Close"
              onClick={onClose}
            >
              <X className="h-4 w-4" strokeWidth={2.25} aria-hidden />
            </button>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[12px] leading-snug">
            <p>
              <span className="text-slate-400">Tracking</span>{" "}
              <span className="font-mono font-semibold text-white">{context.tracking_number}</span>
            </p>
            {context.carrier ? (
              <p className="mt-1">
                <span className="text-slate-400">Carrier</span>{" "}
                <span className="font-semibold text-white">{context.carrier}</span>
              </p>
            ) : null}
            {context.order_id ? (
              <p className="mt-1">
                <span className="text-slate-400">Order ID</span>{" "}
                <span className="font-mono font-semibold text-white">{context.order_id}</span>
              </p>
            ) : null}
            <p className="mt-1.5 font-semibold text-white">
              Expected: {context.expected_total_units} units / {context.expected_item_types} item type
              {context.expected_item_types !== 1 ? "s" : ""}
            </p>
            <p className="mt-0.5 font-semibold tabular-nums text-sky-100">
              Scanned: {summary.scannedUnits} / {context.expected_total_units}
            </p>
          </div>
        </header>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <ul className="space-y-2">
            {context.lines.map((line) => {
              const status = deriveShipmentExpectedLineStatus(line, atFinalReview);
              const ids = identifierLine(line);
              return (
                <li
                  key={line.lineKey}
                  className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 text-[12px] font-semibold leading-snug text-white">{line.title}</p>
                    <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wide ${STATUS_TONE[status]}`}>
                      {formatShipmentExpectedLineStatusLabel(status)}
                    </span>
                  </div>
                  {ids ? (
                    <p className="mt-1 font-mono text-[10px] leading-snug text-slate-400">{ids}</p>
                  ) : null}
                  <p className="mt-1.5 text-[11px] font-semibold tabular-nums text-slate-200">
                    Expected {line.expectedQty} · Scanned {line.scannedQty}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>,
    document.body,
  );
}
