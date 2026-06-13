"use client";

import { Lock } from "lucide-react";

import { TASK_CENTER_WRITE_PHASE_NOTICE } from "@/lib/task-center/task-center-api-contract";
import { TASK_CENTER_PHASE_NOTICE_COPY } from "@/lib/task-center/task-center-ui-contract";

export function TaskCenterPhaseNotice({
  compact = false,
  variant = "write",
}: {
  compact?: boolean;
  variant?: "write" | "schema" | "scanner" | "empty";
}) {
  const copy =
    variant === "schema"
      ? TASK_CENTER_PHASE_NOTICE_COPY.schemaReady
      : variant === "scanner"
        ? TASK_CENTER_PHASE_NOTICE_COPY.scannerDeferred
        : variant === "empty"
          ? "No tasks yet — task write phase is not enabled."
          : TASK_CENTER_WRITE_PHASE_NOTICE;

  return (
    <div
      className={`flex items-start gap-2 rounded-xl border border-teal-500/20 bg-teal-500/5 text-xs leading-snug ${
        compact ? "px-3 py-2" : "px-4 py-3"
      }`}
      role="note"
    >
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
      <p className="opacity-85">{copy}</p>
    </div>
  );
}
