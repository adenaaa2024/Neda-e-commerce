"use client";

import { CLAIM_CENTER_KPI_CARD, CLAIM_CENTER_KPI_GRID } from "@/components/claim-center/claim-center-ui";

type Summary = {
  total_previews: number;
  claim_ready: number;
  needs_review: number;
  unavailable: number;
  by_family: Record<string, { total: number; claim_ready: number; needs_review: number; unavailable: number }>;
};

type Props = {
  summary: Summary;
  apiTotal?: number | null;
  loadedCount?: number;
};

export function ClaimPreviewGeneratorsSummary({ summary, apiTotal, loadedCount }: Props) {
  const families = Object.entries(summary.by_family).sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="space-y-4">
      <div className={CLAIM_CENTER_KPI_GRID}>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Total previews</p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{summary.total_previews}</p>
          {loadedCount != null && apiTotal != null && loadedCount < apiTotal ? (
            <p className="mt-1 text-[10px] opacity-60">
              Showing {loadedCount} of {apiTotal} loaded (API limit 200)
            </p>
          ) : null}
        </div>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Claim ready</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-700 dark:text-emerald-300">
            {summary.claim_ready}
          </p>
        </div>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Needs review</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700 dark:text-amber-300">
            {summary.needs_review}
          </p>
        </div>
        <div className={CLAIM_CENTER_KPI_CARD}>
          <p className="text-[11px] font-semibold uppercase opacity-60">Unavailable</p>
          <p className="mt-1 text-2xl font-bold tabular-nums opacity-80">{summary.unavailable}</p>
        </div>
      </div>

      {families.length ? (
        <div className="claim-center-card rounded-xl p-4">
          <p className="mb-3 text-xs font-semibold uppercase opacity-60">By family (filtered)</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {families.map(([family, counts]) => (
              <div key={family} className="rounded-lg border px-3 py-2 text-xs">
                <p className="font-semibold">{family.replace(/_/g, " ")}</p>
                <p className="mt-1 opacity-75">
                  {counts.total} total · {counts.claim_ready} ready · {counts.needs_review} review
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
