"use client";

import type { ClaimCaseReviewSummary } from "@/lib/claims/pilot/claim-case-review-readmodel";
import { CLAIM_CENTER_KPI_CARD, CLAIM_CENTER_KPI_GRID } from "@/components/claim-center/claim-center-ui";

type Props = {
  summary: ClaimCaseReviewSummary;
  pilotCaseRunId: string;
};

export function ClaimCaseReviewSummaryCards({ summary, pilotCaseRunId }: Props) {
  const families = Object.entries(summary.by_family_key_v3).sort(([a], [b]) => a.localeCompare(b));
  const lanes = summary.money_lane_availability;

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2 text-xs">
        <span className="font-semibold">Pilot case run</span>{" "}
        <code className="font-mono text-[10px]">{pilotCaseRunId}</code>
      </div>
      <div className={CLAIM_CENTER_KPI_GRID}>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Total pilot cases</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{summary.total_pilot_cases}</p>
        </div>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Open cases</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
            {summary.open_cases}
          </p>
        </div>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Total clean quantity</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{summary.total_clean_quantity}</p>
        </div>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Warnings</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
            {summary.warning_count}
          </p>
        </div>
      </div>
      {families.length > 0 ? (
        <div className="claim-center-card rounded-xl border p-4">
          <p className="text-[11px] font-semibold uppercase opacity-60">Family distribution</p>
          <ul className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
            {families.map(([fam, n]) => (
              <li key={fam} className="flex justify-between gap-2 rounded-lg bg-black/5 px-3 py-2 dark:bg-white/5">
                <span>{fam.replace(/_/g, " ")}</span>
                <span className="font-bold tabular-nums">{n}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="claim-center-card rounded-xl border p-4">
        <p className="text-[11px] font-semibold uppercase opacity-60">Money lane availability</p>
        <ul className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
          {Object.entries(lanes).map(([lane, n]) => (
            <li key={lane} className="flex justify-between gap-2 rounded-lg bg-black/5 px-3 py-2 dark:bg-white/5">
              <span>{lane.replace(/_/g, " ")}</span>
              <span className="font-bold tabular-nums">
                {n} / {summary.total_pilot_cases}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
