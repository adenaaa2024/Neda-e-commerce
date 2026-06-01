"use client";

import { Loader2, Pause, Play, X } from "lucide-react";

import type { ProductEnrichmentJobUiStatus } from "@/lib/jobs/product-enrichment-job-status";

export function PimCatalogEnrichmentJobPanel({
  status,
  busy,
  error,
  onCancel,
  onResume,
  onDismiss,
  canResume,
}: {
  status: ProductEnrichmentJobUiStatus | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onResume: () => void;
  onDismiss?: () => void;
  canResume: boolean;
}) {
  if (!status && !error) return null;

  const processedLabel =
    status?.total != null
      ? `${status.processed.toLocaleString()} / ${status.total.toLocaleString()}`
      : status
        ? status.processed.toLocaleString()
        : "—";

  const progressPct =
    status?.total != null && status.total > 0
      ? Math.min(100, Math.round((status.processed / status.total) * 100))
      : status?.progress_pct ?? 0;

  const statusLabel = status?.status ?? (error ? "error" : "—");
  const running = Boolean(status?.running || status?.needs_tick) || busy;
  const terminal =
    status?.status === "completed" || status?.status === "cancelled" || status?.status === "failed";

  return (
    <div
      className="mb-3 flex flex-col gap-2 rounded-lg border border-border/70 bg-background/95 px-3 py-2.5 text-sm shadow-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-xs font-semibold text-foreground">Product Data Update</p>
          <p className="text-[11px] text-muted-foreground">
            Runs in the background — you can leave this page anytime.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {canResume && !running ? (
            <button
              type="button"
              onClick={onResume}
              disabled={busy}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] font-medium hover:bg-muted disabled:opacity-50"
            >
              <Play className="h-3 w-3" aria-hidden />
              Resume
            </button>
          ) : null}
          {running ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy && !status?.cancel_requested}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-destructive/40 bg-background px-2 text-[11px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              <Pause className="h-3 w-3" aria-hidden />
              Cancel
            </button>
          ) : null}
          {terminal && onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted"
              aria-label="Dismiss status"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      {running ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${Math.max(progressPct, status?.needs_tick ? 4 : 0)}%` }}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">Status:</span>{" "}
          {running ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              {statusLabel}
            </span>
          ) : (
            statusLabel
          )}
        </span>
        <span>
          <span className="font-medium text-foreground">Processed:</span> {processedLabel}
        </span>
        {status?.failures_count ? (
          <span>
            <span className="font-medium text-foreground">Failures:</span> {status.failures_count}
          </span>
        ) : null}
      </div>

      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
      {status?.last_error && !error ? <p className="text-[11px] text-destructive">{status.last_error}</p> : null}
      {status?.cancel_requested ? (
        <p className="text-[10px] text-muted-foreground">Cancel requested — stops after current batch.</p>
      ) : null}
    </div>
  );
}
