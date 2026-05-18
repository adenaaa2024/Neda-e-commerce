"use client";

import { ChevronDown, ChevronRight, Info } from "lucide-react";
import { useState } from "react";

import type { ImportDescriptorUiSummary } from "@/lib/import/import-classify-response";

const STATUS_STYLES: Record<
  ImportDescriptorUiSummary["classification_status"],
  string
> = {
  ready: "border-emerald-400/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  needs_mapping: "border-amber-400/40 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  unsupported: "border-rose-400/40 bg-rose-500/10 text-rose-800 dark:text-rose-200",
  unknown: "border-border bg-muted/40 text-muted-foreground",
};

const CONFIDENCE_STYLES: Record<
  ImportDescriptorUiSummary["classification_confidence"],
  string
> = {
  high: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-300",
  medium: "bg-sky-600/15 text-sky-700 dark:text-sky-300",
  low: "bg-amber-600/15 text-amber-700 dark:text-amber-300",
};

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  const v = value?.trim();
  if (!v) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-all font-mono text-[11px] text-foreground">{v}</dd>
    </div>
  );
}

type Props = {
  summary: ImportDescriptorUiSummary | null;
  /** Shorter layout for RawReportUploader */
  compact?: boolean;
  className?: string;
};

/**
 * Operator-visible descriptor metadata from classify-headers (advisory only).
 * Does not affect sync/staging/generic routing.
 */
export function ImportDescriptorClassifyPanel({ summary, compact = false, className = "" }: Props) {
  const [open, setOpen] = useState(!compact);

  if (!summary) return null;

  const d = summary.descriptor;
  const statusClass = STATUS_STYLES[summary.classification_status];
  const confidenceClass = CONFIDENCE_STYLES[summary.classification_confidence];

  return (
    <div
      className={`rounded-lg border border-violet-400/30 bg-violet-500/5 ${className}`}
      data-testid="import-descriptor-classify-panel"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-violet-600" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-violet-600" aria-hidden />
        )}
        <Info className="h-3.5 w-3.5 shrink-0 text-violet-600" aria-hidden />
        <span className="text-xs font-semibold text-violet-900 dark:text-violet-100">
          Import descriptor (advisory)
        </span>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium ${confidenceClass}`}>
          {summary.classification_confidence}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-violet-400/20 px-3 pb-3 pt-2">
          <div className={`rounded-md px-2 py-1.5 text-[11px] font-medium ${statusClass}`}>
            Status: {summary.classification_status_label}
            <span className="mt-0.5 block text-[10px] font-normal opacity-90">
              Confidence: {summary.classification_confidence_label}
            </span>
          </div>

          {d ? (
            <dl className="grid gap-2 sm:grid-cols-2">
              <Field label="descriptor_id" value={d.descriptor_id} />
              <Field label="descriptor_version" value={String(d.descriptor_version)} />
              <Field label="provider" value={d.provider} />
              <Field label="source_family" value={d.source_family} />
              <Field label="import_kind" value={d.import_kind ?? "—"} />
              <Field label="classify_profile" value={d.classify_profile} />
              <Field label="report_type" value={summary.report_type} />
              <Field label="classify_source" value={summary.classify_source ?? undefined} />
              {!compact && (
                <Field label="matched_rule" value={summary.matched_rule ?? undefined} />
              )}
            </dl>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No registry descriptor for <span className="font-mono">{summary.report_type}</span> (e.g.
              UNKNOWN or planned API-only sources).
            </p>
          )}

          <p className="text-[10px] leading-snug text-muted-foreground">
            Metadata is for operators and future API workers. Staging and sync still use{" "}
            <span className="font-mono">report_type</span> only.
          </p>
        </div>
      )}
    </div>
  );
}
