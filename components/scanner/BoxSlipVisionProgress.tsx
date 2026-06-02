"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import {
  BOX_SLIP_VISION_PROGRESS_LABEL,
  BOX_SLIP_VISION_PROGRESS_ORDER,
  boxSlipVisionProgressChipState,
  type BoxSlipVisionProgressPhase,
} from "@/lib/scanner/operator-scan-progress-ui";

const CHIP_CLASS = {
  done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-100",
  active: "border-[#d6b76e]/50 bg-[#d6b76e]/15 text-[#faf6ed]",
  pending: "border-slate-600/45 bg-slate-900/50 text-slate-500",
  hidden: "hidden",
} as const;

export function BoxSlipVisionProgress({
  phase,
  slowHint,
  invalidFormat,
  onReplaceSlipHint,
  className = "",
}: {
  phase: BoxSlipVisionProgressPhase;
  slowHint?: boolean;
  invalidFormat?: boolean;
  /** Shown when invalidFormat — uploader is the replace action */
  onReplaceSlipHint?: string;
  className?: string;
}) {
  const busy = phase !== "idle" && phase !== "ready_to_save" && phase !== "error";
  const showChips = phase !== "idle";

  return (
    <div className={`space-y-2 ${className}`} role="status" aria-live="polite">
      {invalidFormat ? (
        <div className="rounded-xl border border-amber-500/45 bg-amber-950/40 px-3 py-2.5 text-left">
          <p className="text-[11px] font-bold leading-snug text-amber-100">
            Unreadable packing slip — Save stays blocked
          </p>
          <p className="mt-1 text-[10px] font-medium leading-snug text-amber-100/85">
            {onReplaceSlipHint ??
              "Replace the packing slip photo with a clear image showing slip id, item lines, and barcodes. Your photo is still available in the uploader above."}
          </p>
        </div>
      ) : null}

      {showChips ? (
        <div
          className={
            busy
              ? "rounded-xl border border-slate-600/50 bg-slate-950/80 px-3 py-2.5 backdrop-blur-sm"
              : "rounded-xl border border-slate-700/40 bg-slate-900/60 px-3 py-2"
          }
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {BOX_SLIP_VISION_PROGRESS_ORDER.map((chip) => {
              const st = boxSlipVisionProgressChipState(chip, phase);
              if (st === "hidden") return null;
              return (
                <span
                  key={chip}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${CHIP_CLASS[st]}`}
                >
                  {st === "active" ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : st === "done" ? (
                    <CheckCircle2 className="h-3 w-3 opacity-80" aria-hidden />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-current opacity-40" aria-hidden />
                  )}
                  {BOX_SLIP_VISION_PROGRESS_LABEL[chip]}
                </span>
              );
            })}
          </div>
          {phase === "reading_slip" || phase === "preparing_image" ? (
            <p className="mt-2 text-[10px] font-semibold leading-snug text-slate-400">
              {BOX_SLIP_VISION_PROGRESS_LABEL[phase]}…
              {slowHint ? (
                <span className="mt-1 block text-amber-200/90">
                  If this takes too long, check the network. Your photo is still available.
                </span>
              ) : null}
            </p>
          ) : null}
          {phase === "ready_to_save" ? (
            <p className="mt-2 text-[10px] font-semibold text-emerald-200/90">
              {BOX_SLIP_VISION_PROGRESS_LABEL.ready_to_save} — review lines, then Confirm &amp; Save.
            </p>
          ) : null}
          {phase === "error" ? (
            <p className="mt-2 flex items-center gap-1.5 text-[10px] font-semibold text-rose-200">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Could not read this slip. Retake the photo or enter slip details manually.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
