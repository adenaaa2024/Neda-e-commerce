"use client";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

import { claimCenterBadgeTone } from "./claim-center-ui";

type Props = {
  rows: ClaimCenterV1Row[];
  onSelect?: (row: ClaimCenterV1Row) => void;
  emptyLabel?: string;
};

function money(v: number | null): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
}

export function ClaimCenterMobileCards({ rows, onSelect, emptyLabel = "No items in scope." }: Props) {
  if (!rows.length) {
    return <p className="py-8 text-center text-sm opacity-60">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className="claim-center-mobile-card w-full text-left"
          onClick={() => onSelect?.(row)}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{row.v1_status_label}</p>
              <p className="mt-0.5 text-xs opacity-70">
                {[row.sku, row.asin].filter(Boolean).join(" · ") || row.claim_reason || row.id.slice(0, 8)}
              </p>
            </div>
            <p className="shrink-0 text-sm font-bold">{money(row.recovery_value)}</p>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {row.badges.slice(0, 5).map((b, i) => (
              <span key={`${row.id}-${b.kind}-${i}`} className={claimCenterBadgeTone(b.tone)}>
                {b.label}
              </span>
            ))}
          </div>
          {row.canonical_window.deadline ? (
            <p className="mt-2 text-xs opacity-70">Filing deadline: {row.canonical_window.deadline}</p>
          ) : null}
        </button>
      ))}
    </div>
  );
}
