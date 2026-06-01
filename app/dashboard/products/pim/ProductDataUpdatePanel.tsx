"use client";

import React from "react";
import { Ban, Loader2, Pause, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { PimHelpNote } from "./PimHelpNote";

export type ProductDataUpdateJobState =
  | "idle"
  | "running"
  | "paused"
  | "failed"
  | "completed"
  | "cancelled";

export type ProductDataUpdateMode = "off" | "dry-run" | "apply";

export type ProductDataUpdatePanelProps = {
  jobState: ProductDataUpdateJobState;
  mode: ProductDataUpdateMode;
  progressPct: number | null;
  stageLabel: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  rowsProcessed: number | null;
  rowsTotal: number | null;
  busy: boolean;
  canStartPreview: boolean;
  canStartApply: boolean;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canRetryFailed: boolean;
  onStartPreview: () => void;
  onStartApply: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRetryFailed: () => void;
  onRefreshStatus: () => void;
};

const STATE_TONE: Record<ProductDataUpdateJobState, string> = {
  idle: "bg-muted text-muted-foreground",
  running: "bg-violet-500/15 text-violet-900 dark:text-violet-100",
  paused: "bg-amber-500/15 text-amber-950 dark:text-amber-100",
  failed: "bg-red-500/15 text-red-900 dark:text-red-100",
  completed: "bg-emerald-500/15 text-emerald-900 dark:text-emerald-100",
  cancelled: "bg-muted text-muted-foreground",
};

const STATE_LABEL: Record<ProductDataUpdateJobState, string> = {
  idle: "Idle",
  running: "Running",
  paused: "Paused",
  failed: "Failed",
  completed: "Completed",
  cancelled: "Cancelled",
};

const MODE_LABEL: Record<ProductDataUpdateMode, string> = {
  off: "Off (safe)",
  "dry-run": "Dry-run / preview",
  apply: "Apply (writes)",
};

function fmtWhen(iso: string | null): string {
  if (!iso?.trim()) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

export function ProductDataUpdatePanel(props: ProductDataUpdatePanelProps) {
  const {
    jobState,
    mode,
    progressPct,
    stageLabel,
    lastRunAt,
    nextRunAt,
    lastError,
    rowsProcessed,
    rowsTotal,
    busy,
    canStartPreview,
    canStartApply,
    canPause,
    canResume,
    canCancel,
    canRetryFailed,
    onStartPreview,
    onStartApply,
    onPause,
    onResume,
    onCancel,
    onRetryFailed,
    onRefreshStatus,
  } = props;

  const btn =
    "inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45";
  const btnPri =
    "inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45";
  const btnDanger =
    "inline-flex items-center justify-center gap-1.5 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive transition hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-45";

  return (
    <section
      className="rounded-xl border border-primary/25 bg-gradient-to-br from-card/90 to-muted/20 p-4 shadow-sm sm:p-5"
      aria-labelledby="product-data-update-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="product-data-update-heading" className="text-sm font-semibold text-foreground">
              Product data update
            </h3>
            <PimHelpNote label="Product data update safety">
              <div className="max-w-sm space-y-2 text-xs leading-relaxed">
                <p>
                  Opening this page never starts or continues a job. Use <strong>Start</strong> for preview (dry-run) or{" "}
                  <strong>Start apply</strong> after preview is ready. Status polling is read-only.
                </p>
                <p>
                  <strong>Pause</strong> stops the browser from sending the next chunk; resume with <strong>Resume</strong>.
                  <strong> Cancel</strong> marks the server job cancelled.
                </p>
              </div>
            </PimHelpNote>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Explicit controls only — no automatic preview or import on page load.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATE_TONE[jobState]}`}>
            {busy && jobState === "running" ? (
              <Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden />
            ) : null}
            {STATE_LABEL[jobState]}
          </span>
          <span className="inline-flex rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-foreground">
            Mode: {MODE_LABEL[mode]}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Progress</p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-foreground">
            {progressPct != null ? `${Math.round(progressPct)}%` : "—"}
            {rowsTotal != null ? (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                ({rowsProcessed ?? 0} / {rowsTotal} rows)
              </span>
            ) : null}
          </p>
          {progressPct != null ? (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
              />
            </div>
          ) : null}
          {stageLabel ? <p className="mt-1 truncate text-[11px] text-muted-foreground">{stageLabel}</p> : null}
        </div>
        <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Last run</p>
          <p className="mt-1 text-sm text-foreground">{fmtWhen(lastRunAt)}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Next run</p>
          <p className="mt-1 text-sm text-foreground">{fmtWhen(nextRunAt)}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Last error</p>
          <p className="mt-1 line-clamp-2 text-sm text-destructive">{lastError?.trim() || "—"}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={btnPri} disabled={!canStartPreview || busy} onClick={onStartPreview}>
          <Play className="h-3.5 w-3.5" aria-hidden />
          Start preview
        </button>
        <button type="button" className={btnPri} disabled={!canStartApply || busy} onClick={onStartApply}>
          <Play className="h-3.5 w-3.5" aria-hidden />
          Start apply
        </button>
        <button type="button" className={btn} disabled={!canPause || busy} onClick={onPause}>
          <Pause className="h-3.5 w-3.5" aria-hidden />
          Pause
        </button>
        <button type="button" className={btn} disabled={!canResume || busy} onClick={onResume}>
          <Play className="h-3.5 w-3.5" aria-hidden />
          Resume
        </button>
        <button type="button" className={btnDanger} disabled={!canCancel || busy} onClick={onCancel}>
          <Square className="h-3.5 w-3.5" aria-hidden />
          Cancel
        </button>
        <button type="button" className={btn} disabled={!canRetryFailed || busy} onClick={onRetryFailed}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Retry failed
        </button>
        <button type="button" className={btn} disabled={busy} onClick={onRefreshStatus}>
          <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden />
          Refresh status
        </button>
      </div>

      {jobState === "idle" && mode === "off" ? (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Safe default: no product update job runs until you choose Start preview or Start apply.
        </p>
      ) : null}
    </section>
  );
}
