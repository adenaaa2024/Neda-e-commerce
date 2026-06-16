"use client";

import type { WorkflowStageCounts } from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import {
  WORKFLOW_STAGES,
  pickHighlightedWorkflowStage,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";

type Props = {
  counts: WorkflowStageCounts;
};

export function ReimbursementTrackingWorkflowStrip({ counts }: Props) {
  const highlighted = pickHighlightedWorkflowStage(counts);

  return (
    <section className="claim-center-card rounded-xl border p-4 sm:p-5">
      <h2 className="text-sm font-semibold">Submission workflow</h2>
      <p className="mt-1 text-xs opacity-70">Pilot submission distribution across filing and recovery stages.</p>
      <ol className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {WORKFLOW_STAGES.map((stage, idx) => {
          const active = stage.id === highlighted;
          return (
            <li
              key={stage.id}
              className={`min-w-[140px] flex-1 rounded-xl border px-3 py-3 ${
                active
                  ? "border-violet-500/50 bg-violet-500/10 ring-1 ring-violet-500/30"
                  : "border-black/10 bg-black/[0.02] dark:border-white/10 dark:bg-white/[0.02]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                    active ? "bg-violet-600 text-white" : "bg-black/10 dark:bg-white/10"
                  }`}
                >
                  {idx + 1}
                </span>
                <span className="text-xs font-semibold leading-tight">{stage.label}</span>
              </div>
              <p className="mt-2 text-2xl font-bold tabular-nums">{counts[stage.id]}</p>
              <p className="mt-1 text-[10px] leading-snug opacity-60">{stage.description}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
