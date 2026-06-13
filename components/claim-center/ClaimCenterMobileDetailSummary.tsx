"use client";

import { Calendar, DollarSign } from "lucide-react";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

import { claimCenterBadgeTone } from "./claim-center-ui";

function money(row: ClaimCenterV1Row): string {
  return row.money_display?.amount_display_label ?? "Cost unknown";
}

function sourceLabel(row: ClaimCenterV1Row): string {
  return row.badges.find((b) => b.kind === "source")?.label ?? row.source_kind ?? "—";
}

function blockerBadge(row: ClaimCenterV1Row) {
  return (
    row.badges.find((b) => b.kind === "trid" && b.tone === "danger") ??
    row.badges.find((b) => b.kind === "product" && b.tone === "warning") ??
    row.badges.find((b) => b.kind === "evidence" && b.tone === "warning") ??
    row.badges.find((b) => b.kind === "conflict")
  );
}

/** Sticky opportunity summary for mobile detail sheet. */
export function ClaimCenterMobileDetailSummary({ row }: { row: ClaimCenterV1Row }) {
  const blocker = blockerBadge(row);
  const elig = row.eligibility_display?.status ?? row.canonical_window.status;
  const windowTone =
    elig === "expired"
      ? "danger"
      : elig === "expiring_soon"
        ? "warning"
        : "neutral";

  return (
    <div
      className="claim-center-mobile-detail-summary sticky top-0 z-10 -mx-1 mb-4 rounded-xl border border-black/10 bg-inherit/95 p-4 backdrop-blur-sm dark:border-white/10"
      data-claim-center="mobile-detail-summary"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wide opacity-50">Exposure</p>
          <p className="flex items-center gap-1.5 text-xl font-bold tabular-nums">
            <DollarSign className="h-4 w-4 opacity-60" aria-hidden />
            {money(row)}
          </p>
          <p className="mt-1 truncate text-xs capitalize opacity-70">
            {row.physical_return_display?.physical_family_label ?? "Physical return issue"} · {sourceLabel(row)}
          </p>
        </div>
        <span className={claimCenterBadgeTone(windowTone)}>
          <Calendar className="mr-1 inline h-3 w-3" aria-hidden />
          {row.canonical_window.deadline ?? "No deadline"}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {blocker ? (
          <span className={claimCenterBadgeTone(blocker.tone)}>{blocker.label}</span>
        ) : null}
        {row.badges
          .filter((b) => ["product", "evidence", "source"].includes(b.kind))
          .slice(0, 3)
          .map((b, i) => (
            <span key={`${b.kind}-${i}`} className={claimCenterBadgeTone(b.tone)}>
              {b.label}
            </span>
          ))}
      </div>
    </div>
  );
}
