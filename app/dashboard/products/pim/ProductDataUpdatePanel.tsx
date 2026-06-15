"use client";

import React from "react";
import { Ban, Eye, Loader2, Pause, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import type { ProductDataUpdatePreviewSummary } from "@/lib/pim-catalog-enrichment-preview-samples";
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
  jobIdShort?: string | null;
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
  previewBusy?: boolean;
  previewError?: string | null;
  previewSummary?: ProductDataUpdatePreviewSummary | null;
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
  paused: "Awaiting resume",
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
    jobIdShort,
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
    previewBusy = false,
    previewError = null,
    previewSummary = null,
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
            {jobIdShort && process.env.NODE_ENV === "development" ? (
              <span className="ml-2 font-mono text-[10px] text-muted-foreground/80">job {jobIdShort}</span>
            ) : null}
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
        <button
          type="button"
          className={btnPri}
          disabled={!canStartPreview || busy}
          title="Dry-run only — reads Amazon APIs and reports would-update counts. No product, map, or price writes."
          onClick={onStartPreview}
        >
          {previewBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Eye className="h-3.5 w-3.5" aria-hidden />
          )}
          Start preview (no writes)
        </button>
        <button
          type="button"
          className={btnPri}
          disabled={!canStartApply || busy}
          title="Starts a background apply job that writes product data. Separate from preview."
          onClick={onStartApply}
        >
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

      {jobState === "paused" ? (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100">
          <Pause className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Job is loaded on the server but not advancing. Use <strong>Resume</strong> to continue or{" "}
          <strong>Cancel</strong> to stop. Refresh status is read-only.
        </p>
      ) : null}

      {jobState === "idle" && mode === "off" ? (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Safe default: no product update job runs until you choose Start preview or Start apply.
        </p>
      ) : null}

      {previewError ? (
        <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Preview failed: {previewError}
        </p>
      ) : null}

      {previewSummary ? (
        <div className="mt-3 space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-foreground">
              Preview result <span className="font-normal text-muted-foreground">(dry-run — no writes)</span>
            </p>
            <p className="text-[11px] text-muted-foreground">Ran {fmtWhen(previewSummary.ran_at)}</p>
          </div>
          <ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-4">
            <li>
              would update:{" "}
              <span className="font-semibold tabular-nums text-foreground">{previewSummary.would_update_count}</span>
            </li>
            <li>
              would skip:{" "}
              <span className="font-semibold tabular-nums text-foreground">{previewSummary.would_skip_count}</span>
            </li>
            <li>
              missing data:{" "}
              <span className="font-semibold tabular-nums text-foreground">{previewSummary.missing_data_count}</span>
            </li>
            <li>
              samples scanned:{" "}
              <span className="font-semibold tabular-nums text-foreground">{previewSummary.sample_count}</span>
            </li>
          </ul>
          {previewSummary.rate_limit_warnings.length > 0 ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-950 dark:text-amber-100">
              <p className="font-medium">Rate-limit warnings</p>
              <ul className="mt-0.5 list-inside list-disc">
                {previewSummary.rate_limit_warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {previewSummary.api_errors.length > 0 ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 px-2 py-1.5">
              <p className="font-medium text-destructive">API errors ({previewSummary.api_errors.length})</p>
              <ul className="mt-0.5 max-h-32 space-y-1 overflow-y-auto text-[11px] text-muted-foreground">
                {previewSummary.api_errors.map((e) => (
                  <li key={`${e.product_id}:${e.reason}`} className="break-words">
                    <span className="font-mono text-foreground">{e.product_id.slice(0, 8)}…</span>: {e.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {previewSummary.sample_products.length > 0 ? (
            <div>
              <p className="font-medium text-foreground">Sample products</p>
              <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-[11px] text-muted-foreground">
                {previewSummary.sample_products.map((s) => (
                  <li key={s.id} className="rounded border border-border/40 bg-background/60 px-2 py-1">
                    <span className="font-mono text-foreground">{s.asin ?? "—"}</span>
                    {s.product_name ? ` · ${s.product_name}` : null}
                    <span className="ml-1 text-[10px] uppercase tracking-wide">({s.bucket})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            Start apply remains a separate explicit action — preview does not enqueue a job or write data.
          </p>
        </div>
      ) : null}
    </section>
  );
}
