"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import {
  OPERATOR_SCAN_PROGRESS_LABEL,
  OPERATOR_SCAN_PROGRESS_ORDER,
  operatorScanProgressChipState,
  type OperatorScanProgressPhase,
} from "@/lib/scanner/operator-scan-progress-ui";

const CHIP_CLASS = {
  done: "border-emerald-500/35 bg-emerald-500/10 text-emerald-100",
  active: "border-[#d6b76e]/55 bg-[#d6b76e]/12 text-[#faf6ed]",
  pending: "border-slate-600/50 bg-slate-900/40 text-slate-500",
  hidden: "hidden",
} as const;

export function OperatorScanProgressStrip({
  phase,
  errorMessage,
  className = "",
}: {
  phase: OperatorScanProgressPhase;
  errorMessage?: string | null;
  className?: string;
}) {
  const label = OPERATOR_SCAN_PROGRESS_LABEL[phase];
  const showChips = phase !== "idle";

  return (
    <div
      className={`min-h-[2.75rem] ${className}`}
      role={showChips ? "status" : undefined}
      aria-live="polite"
      aria-label={label || undefined}
    >
      {phase === "error" ? (
        <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-950/35 px-3 py-2 text-[12px] font-semibold text-rose-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{errorMessage?.trim() || "Lookup failed — try again or enter manually."}</span>
        </div>
      ) : showChips ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {OPERATOR_SCAN_PROGRESS_ORDER.map((chip) => {
              const st = operatorScanProgressChipState(chip, phase);
              if (st === "hidden") return null;
              const chipLabel = OPERATOR_SCAN_PROGRESS_LABEL[chip];
              return (
                <span
                  key={chip}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${CHIP_CLASS[st]}`}
                >
                  {st === "active" ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : st === "done" ? (
                    <CheckCircle2 className="h-3 w-3 opacity-80" aria-hidden />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-current opacity-40" aria-hidden />
                  )}
                  {chipLabel}
                </span>
              );
            })}
            {phase === "needs_review" ? (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${CHIP_CLASS.active}`}
              >
                <AlertTriangle className="h-3 w-3" aria-hidden />
                {OPERATOR_SCAN_PROGRESS_LABEL.needs_review}
              </span>
            ) : null}
            {phase === "ready" ? (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${CHIP_CLASS.done}`}
              >
                <CheckCircle2 className="h-3 w-3" aria-hidden />
                {OPERATOR_SCAN_PROGRESS_LABEL.ready}
              </span>
            ) : null}
          </div>
          {label && phase !== "ready" && phase !== "needs_review" ? (
            <p className="text-center text-[12px] font-semibold text-[#b9c2cc]">{label}…</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
