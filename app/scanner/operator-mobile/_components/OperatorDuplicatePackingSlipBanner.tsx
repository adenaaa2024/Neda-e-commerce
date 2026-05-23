"use client";

import { AlertTriangle } from "lucide-react";
import {
  DUPLICATE_PACKING_SLIP_TITLE,
  formatDuplicatePackingSlipMessage,
} from "@/lib/scanner/operator-slip-duplicate";

/**
 * Minimal warning surface for duplicate `packages.id_slip_contents` (BOX intake).
 * Amber / orange theme — distinct from red security (cross-store) alerts.
 */
export function OperatorDuplicatePackingSlipBanner({
  slipCode,
  otherPackageCode,
  onDismiss,
  className = "",
}: {
  slipCode: string;
  otherPackageCode: string;
  onDismiss?: () => void;
  className?: string;
}) {
  const slip = (slipCode ?? "").trim();
  const body = formatDuplicatePackingSlipMessage(slip, otherPackageCode);
  return (
    <div
      role="alert"
      aria-live="polite"
      className={[
        "scroll-mt-4 rounded-xl border border-amber-500/40 bg-amber-950/25 px-2.5 py-2 shadow-sm backdrop-blur-[2px]",
        "dark:border-amber-400/35 dark:bg-amber-950/30",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-400/95"
          strokeWidth={2.25}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold leading-tight tracking-tight text-amber-50/95">
            {DUPLICATE_PACKING_SLIP_TITLE}
          </p>
          <p className="mt-0.5 text-[10px] font-medium leading-snug text-amber-100/80">{body}</p>
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              className="mt-1.5 text-[10px] font-semibold text-amber-200/90 underline decoration-amber-500/50 underline-offset-2 transition hover:text-amber-50"
            >
              Dismiss
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
