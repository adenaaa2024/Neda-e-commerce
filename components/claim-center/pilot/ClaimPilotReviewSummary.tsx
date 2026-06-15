"use client";

import type { ClaimPilotReviewSummary } from "@/lib/claims/pilot/claim-pilot-review-readmodel";
import { CLAIM_CENTER_KPI_CARD, CLAIM_CENTER_KPI_GRID } from "@/components/claim-center/claim-center-ui";

type Props = {
  summary: ClaimPilotReviewSummary;
  intakeRunId: string;
};

export function ClaimPilotReviewSummaryCards({ summary, intakeRunId }: Props) {
  const families = Object.entries(summary.by_family_key_v3).sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
        <span className="font-semibold">Pilot intake run</span>{" "}
        <code className="font-mono text-[10px]">{intakeRunId}</code>
      </div>
      <div className={CLAIM_CENTER_KPI_GRID}>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Total pilot candidates</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{summary.total_pilot_candidates}</p>
        </div>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Detected</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
            {summary.detected_count}
          </p>
        </div>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Date gate passed</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{summary.date_gate_passed_count}</p>
        </div>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Missing evidence</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
            {summary.missing_evidence_count}
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
    </section>
  );
}
