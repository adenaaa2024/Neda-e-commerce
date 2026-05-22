"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";

import {
  filterActionableWarnings,
  type ClaimEvidenceDraftOperatorState,
  type FilingReadinessGate,
} from "@/lib/claim-evidence-filing-readiness";
import type { ClaimEvidenceWarning } from "@/lib/claim-evidence-preview";

type Props = {
  organizationId: string;
  draftId: string;
  filingReadiness: FilingReadinessGate | null | undefined;
  operatorState: ClaimEvidenceDraftOperatorState | null | undefined;
  warnings: ClaimEvidenceWarning[];
  onRefresh: () => void;
};

export function ClaimEvidenceFilingReadinessPanel({
  organizationId,
  draftId,
  filingReadiness,
  operatorState,
  warnings,
  onRefresh,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!filingReadiness) return null;

  const actionable = filterActionableWarnings(warnings).filter(
    (w) => w.code !== "preview_only" && w.code !== "persisted_edges_available",
  );
  const rs = filingReadiness.review_summary;

  async function acknowledgeWarnings() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/claims/drafts/${encodeURIComponent(draftId)}/evidence-warnings/acknowledge`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organization_id: organizationId }),
        },
      );
      const j = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setErr(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
        return;
      }
      onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Acknowledge failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={`rounded-lg border px-2.5 py-2 ${filingReadiness.ready ? "border-sky-200 bg-sky-50/80 dark:border-sky-900 dark:bg-sky-950/40" : "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-800 dark:text-slate-100">
          Filing readiness (gate only)
        </h4>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${filingReadiness.ready ? "bg-sky-600 text-white" : "bg-amber-600 text-white"}`}
        >
          {filingReadiness.ready ? "Ready" : "Not ready"}
        </span>
      </div>
      <p className="mt-1 text-[10px] text-slate-600 dark:text-slate-400">
        Does not submit claims. Checks persisted edge review + evidence warnings.
      </p>

      <ul className="mt-2 space-y-1 text-[10px]">
        <li className={filingReadiness.all_edges_reviewed ? "text-emerald-700 dark:text-emerald-300" : "text-amber-800"}>
          {filingReadiness.all_edges_reviewed ? "✓" : "○"} All edges reviewed ({rs.needs_review} need review of {rs.total})
        </li>
        <li className={filingReadiness.no_blocking_rejected ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700"}>
          {filingReadiness.no_blocking_rejected ? "✓" : "○"} No rejected edges ({rs.rejected} rejected)
        </li>
        <li
          className={
            filingReadiness.warnings_clear_or_acknowledged
              ? "text-emerald-700 dark:text-emerald-300"
              : "text-amber-800"
          }
        >
          {filingReadiness.warnings_clear_or_acknowledged ? "✓" : "○"} Warnings clear or acknowledged (
          {actionable.length} actionable
          {operatorState?.warnings_acknowledged_at ? ", acknowledged" : ""})
        </li>
      </ul>

      <p className="mt-2 text-[10px] font-medium text-slate-700 dark:text-slate-300">
        Counts: {rs.accepted} accepted · {rs.rejected} rejected · {rs.needs_review} needs review
      </p>

      {filingReadiness.blockers.length > 0 ? (
        <ul className="mt-1.5 list-inside list-disc text-[10px] text-amber-900 dark:text-amber-200">
          {filingReadiness.blockers.map((b) => (
            <li key={b}>{b.replace(/_/g, " ")}</li>
          ))}
        </ul>
      ) : null}

      {actionable.length > 0 && !operatorState?.warnings_acknowledged_at ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void acknowledgeWarnings()}
          className="mt-2 rounded border border-sky-400/70 bg-white px-2 py-1 text-[10px] font-medium text-sky-800 hover:bg-sky-50 disabled:opacity-50 dark:bg-slate-900 dark:text-sky-200"
        >
          {busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} Acknowledge evidence warnings
        </button>
      ) : null}

      {err ? <p className="mt-1 text-[10px] text-rose-600">{err}</p> : null}
    </section>
  );
}
