"use client";

import React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import type { ApiFlagWarning } from "@/lib/platform-automation-api-flags";
import type { AutomationCardManualRunState } from "@/lib/platform-automation-settings-types";
import {
  formatAutomationStatusLabel,
  formatAutomationTimestamp,
} from "@/lib/platform-automation-ui-format";
import type { AutomationScheduleRuntime } from "@/lib/platform-automation-settings-types";
import type { RemovalRunSource } from "@/lib/platform-automation-saved-status";
import type { AutomationApiReportType } from "@/lib/platform-automation-api-report-type";
import { AUTOMATION_API_REPORT_TYPE_OPTIONS } from "@/lib/platform-automation-api-report-type";
import { responsiveFormInput } from "@/lib/responsive-page-shell";

export type SavedStatusCardSnapshot = {
  label: string;
  enabled: boolean;
  lastRun: string | null;
  nextRun: Date | null;
  status: string;
  lastSuccess?: string | null;
  runSource?: RemovalRunSource;
};

function removalSourceLabel(source: RemovalRunSource | undefined): string | null {
  if (!source) return null;
  if (source === "cron") return "Vercel cron (scheduled)";
  if (source === "manual") return "Manual Run now / import";
  return "Unknown";
}

type CardKey = "product" | "removal" | "historical" | "reimbursements" | "settlement" | "finances";

const CARD_KEYS_BY_REPORT_TYPE: Record<AutomationApiReportType, CardKey> = {
  product_data_update: "product",
  removal_shipment: "removal",
  reimbursements: "reimbursements",
  settlement: "settlement",
  finances_archive: "finances",
  older_backfill: "historical",
};

function primaryCardForReportType(apiReportType: AutomationApiReportType): CardKey {
  return CARD_KEYS_BY_REPORT_TYPE[apiReportType];
}

function SavedStatusPrimaryPanel({ card }: { card: SavedStatusCardSnapshot }) {
  const lastRun = formatAutomationTimestamp(card.lastRun);
  const lastSuccess = card.lastSuccess != null ? formatAutomationTimestamp(card.lastSuccess) : null;
  const nextRun = card.nextRun ? formatAutomationTimestamp(card.nextRun.toISOString()) : null;
  const sourceLabel = removalSourceLabel(card.runSource);

  return (
    <div className="rounded-lg border border-border/70 bg-muted/10 p-3 sm:col-span-2 lg:col-span-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{card.label}</dt>
      <dd className="mt-1 text-sm font-semibold text-foreground">
        {card.enabled ? "Enabled (scheduled)" : "Off"}
      </dd>
      <dd className="mt-2 text-xs text-muted-foreground">
        Next run:{" "}
        {card.enabled && nextRun ? (
          <>
            {nextRun.primary}
            {nextRun.secondary ? ` (${nextRun.secondary})` : ""}
          </>
        ) : (
          "Off — not scheduled"
        )}
      </dd>
      <dd className="mt-1 text-xs text-muted-foreground">
        Last run: {lastRun.primary}
        {lastRun.secondary ? ` · ${lastRun.secondary}` : ""}
      </dd>
      {lastSuccess ? (
        <dd className="mt-1 text-xs text-muted-foreground">
          Last success: {lastSuccess!.primary !== "Never" ? lastSuccess!.primary : "—"}
        </dd>
      ) : null}
      <dd className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Status</span>
        <StatusPill status={card.status} />
      </dd>
      {sourceLabel ? (
        <dd className="mt-1 text-[11px] text-muted-foreground">Source: {sourceLabel}</dd>
      ) : null}
    </div>
  );
}

function SavedStatusSecondarySchedules({
  cards,
  primaryKey,
}: {
  cards: Record<CardKey, SavedStatusCardSnapshot>;
  primaryKey: CardKey;
}) {
  const entries = (Object.entries(cards) as [CardKey, SavedStatusCardSnapshot][]).filter(
    ([key]) => key !== primaryKey,
  );

  return (
    <div className="rounded-lg border border-border/70 bg-muted/10 p-3 sm:col-span-2 lg:col-span-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Other saved schedules
      </dt>
      <dd className="mt-2 grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
        {entries.map(([key, card]) => (
          <span key={key}>
            {card.label}: {card.enabled ? "On" : "Off"}
          </span>
        ))}
      </dd>
    </div>
  );
}

export function RollingWindowHelp() {
  return (
    <p className="mt-0.5 text-xs text-muted-foreground">
      Each scheduled run re-checks and upserts the last N calendar days — not only missing days. Data in that
      window is refreshed every run.
    </p>
  );
}

export function ManualWindowHelp() {
  return (
    <p className="mt-0.5 text-xs text-muted-foreground">
      Manual window applies only to Run now / manual backfill. Scheduled cron uses the rolling window — you do
      not need to change these dates daily.
    </p>
  );
}

export function StatusPill({ status }: { status: string }) {
  const cls =
    status === "success"
      ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200"
      : status === "failed"
        ? "bg-red-500/15 text-red-800 dark:text-red-200"
        : status === "running"
          ? "bg-sky-500/15 text-sky-800 dark:text-sky-200"
          : status === "partial"
            ? "bg-amber-500/15 text-amber-900 dark:text-amber-100"
            : "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {formatAutomationStatusLabel(status)}
    </span>
  );
}

export function ScheduleStats({
  enabled,
  lastRun,
  nextRun,
  status,
  error,
  scheduleSource,
}: {
  enabled: boolean;
  lastRun: string | null;
  nextRun: Date | null;
  status: string;
  error?: string | null;
  scheduleSource?: string | null;
}) {
  const last = formatAutomationTimestamp(lastRun);
  const next = nextRun ? formatAutomationTimestamp(nextRun.toISOString()) : null;

  return (
    <dl className="mt-4 grid gap-3 rounded-xl border border-border/70 bg-muted/15 p-3 sm:grid-cols-2">
      <div>
        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Last run</dt>
        <dd className="mt-1 text-sm font-medium text-foreground">{last.primary}</dd>
        {last.secondary ? <dd className="text-[11px] text-muted-foreground">{last.secondary}</dd> : null}
      </div>
      <div>
        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Next run</dt>
        {enabled && next ? (
          <>
            <dd className="mt-1 text-sm font-medium text-foreground">{next.primary}</dd>
            <dd className="text-[11px] text-muted-foreground">{next.secondary}</dd>
          </>
        ) : (
          <dd className="mt-1 text-sm text-muted-foreground">{enabled ? "Not scheduled" : "Off — not scheduled"}</dd>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</dt>
        <StatusPill status={status} />
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
      </div>
      {scheduleSource ? (
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Schedule source</dt>
          <dd className="mt-1 text-[11px] text-muted-foreground">{scheduleSource}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function RuntimeStatsFromView({
  enabled,
  runtime,
  nextRun,
  scheduleSource,
  savedEnabled,
}: {
  enabled: boolean;
  runtime: AutomationScheduleRuntime;
  nextRun: Date | null;
  scheduleSource?: string | null;
  /** When form draft differs from saved DB value, show saved schedule state in label. */
  savedEnabled?: boolean;
}) {
  const scheduleOn = savedEnabled ?? enabled;
  return (
    <ScheduleStats
      enabled={scheduleOn}
      lastRun={runtime.last_run_at}
      nextRun={scheduleOn ? nextRun : null}
      status={runtime.last_run_status}
      error={runtime.last_error}
      scheduleSource={scheduleSource}
    />
  );
}

export function AutomationSavedStatusSummary({
  apiReportType,
  orgId,
  storeId,
  product,
  removal,
  historical,
  reimbursements,
  settlement,
  finances,
  hasUnsavedChanges,
  updatedAt,
}: {
  apiReportType: AutomationApiReportType;
  orgId: string;
  storeId: string;
  product: SavedStatusCardSnapshot;
  removal: SavedStatusCardSnapshot;
  historical: SavedStatusCardSnapshot;
  reimbursements: SavedStatusCardSnapshot;
  settlement: SavedStatusCardSnapshot;
  finances: SavedStatusCardSnapshot;
  hasUnsavedChanges: boolean;
  updatedAt: string | null;
}) {
  const primaryKey = primaryCardForReportType(apiReportType);
  const cards: Record<CardKey, SavedStatusCardSnapshot> = {
    product,
    removal,
    historical,
    reimbursements,
    settlement,
    finances,
  };
  const primaryCard = cards[primaryKey];
  const selectedTypeLabel =
    AUTOMATION_API_REPORT_TYPE_OPTIONS.find((o) => o.value === apiReportType)?.label ?? apiReportType;

  return (
    <section className="rounded-2xl border-2 border-emerald-500/25 bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Saved automation status</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {selectedTypeLabel} · from{" "}
            <span className="font-mono">platform_settings.automation_settings</span> for scope{" "}
            <span className="font-mono">{orgId.slice(0, 8)}…</span> /{" "}
            <span className="font-mono">{storeId.slice(0, 8)}…</span>
            {updatedAt ? ` · saved ${updatedAt.slice(0, 10)}` : null}
          </p>
        </div>
        {hasUnsavedChanges ? (
          <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-900 dark:text-amber-100">
            Unsaved changes
          </span>
        ) : (
          <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-900 dark:text-emerald-100">
            Matches saved settings
          </span>
        )}
      </div>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <SavedStatusPrimaryPanel card={primaryCard} />
        <SavedStatusSecondarySchedules cards={cards} primaryKey={primaryKey} />
      </dl>
    </section>
  );
}

export function EnabledToggle({
  checked,
  onChange,
  title,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 rounded-lg border border-border/60 bg-background/50 p-3 ${disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 rounded border-border"
      />
      <span>
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

export function FeatureFlagBanner({ warning }: { warning: ApiFlagWarning }) {
  if (!warning.disabled) return null;
  return (
    <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
      <p className="font-medium">{warning.title}</p>
      <p className="mt-1 text-xs opacity-90">{warning.detail}</p>
    </div>
  );
}

export function ManualDateRangeFields({
  windowStart,
  windowEnd,
  onStartChange,
  onEndChange,
  disabled,
  hint,
}: {
  windowStart: string;
  windowEnd: string;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
  disabled?: boolean;
  hint?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="block text-sm">
        <span className="font-medium text-foreground">Manual window start</span>
        <input
          type="date"
          value={windowStart}
          disabled={disabled}
          onChange={(e) => onStartChange(e.target.value)}
          className={`${responsiveFormInput} mt-1.5`}
        />
      </label>
      <label className="block text-sm">
        <span className="font-medium text-foreground">Manual window end</span>
        <input
          type="date"
          value={windowEnd}
          disabled={disabled}
          onChange={(e) => onEndChange(e.target.value)}
          className={`${responsiveFormInput} mt-1.5`}
        />
      </label>
      {hint ? <div className="col-span-2 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function RunTimeField({
  id,
  label,
  value,
  onChange,
  runsPerDay,
  hint,
  readOnly,
  formatUtcHoursForDisplay,
  parseHoursUtcFromInput,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  runsPerDay: number;
  hint?: string;
  readOnly?: boolean;
  formatUtcHoursForDisplay: (hours: number[]) => string;
  parseHoursUtcFromInput: (text: string, runsPerDay: number) => number[];
}) {
  const parsedPreview = React.useMemo(() => {
    if (readOnly) return null;
    try {
      return formatUtcHoursForDisplay(parseHoursUtcFromInput(value, runsPerDay));
    } catch {
      return null;
    }
  }, [value, runsPerDay, formatUtcHoursForDisplay, parseHoursUtcFromInput, readOnly]);

  return (
    <label className="block text-sm sm:col-span-2" htmlFor={id}>
      <span className="font-medium text-foreground">{label}</span>
      <input
        id={id}
        type="text"
        value={value}
        readOnly={readOnly}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
        placeholder="06:00, 14:00"
        className={`${responsiveFormInput} mt-1.5 font-mono text-sm ${readOnly ? "cursor-default opacity-80" : ""}`}
      />
      {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
      {parsedPreview ? (
        <span className="mt-1.5 block text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Your timezone:</span> {parsedPreview}
        </span>
      ) : null}
    </label>
  );
}

export function ImportResumeNotice({
  run,
  label,
}: {
  run: AutomationCardManualRunState;
  label: string;
}) {
  const show =
    run.needs_resume ||
    Boolean(run.upload_id) ||
    Boolean(run.source_run_id) ||
    Boolean(run.active_job_id);
  if (!show) return null;

  return (
    <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">{label}</p>
      {run.needs_resume ? (
        <p className="mt-1 text-amber-800 dark:text-amber-100">
          {run.state === "synthetic_upload_ready"
            ? "Step 1 ready — click Resume to continue the import pipeline."
            : "Import paused — click Resume to continue."}
        </p>
      ) : null}
      {run.state && !run.needs_resume ? (
        <p className="mt-1">
          Run state: <span className="font-mono text-foreground">{run.state}</span>
          {run.needs_resume ? " · needs resume" : ""}
        </p>
      ) : null}
      {run.active_job_id ? (
        <p className="mt-0.5 font-mono text-[10px]">Job {run.active_job_id.slice(0, 8)}…</p>
      ) : null}
      {run.upload_id ? (
        <p className="mt-0.5 font-mono text-[10px]">Upload {run.upload_id.slice(0, 8)}…</p>
      ) : null}
      {run.last_error ? <p className="mt-1 text-destructive">{run.last_error}</p> : null}
      <p className="mt-2">
        <Link href="/imports" className="font-medium text-sky-600 underline-offset-2 hover:underline dark:text-sky-400">
          View import history
        </Link>{" "}
        (shared with Data Management imports).
      </p>
    </div>
  );
}

export function ManualRunButtons({
  onRun,
  onResume,
  canResume,
  busy,
  disabled,
  runLabel = "Run now",
  resumeLabel = "Resume",
}: {
  onRun: () => void | Promise<void>;
  onResume?: () => void | Promise<void>;
  canResume?: boolean;
  busy?: boolean;
  disabled?: boolean;
  runLabel?: string;
  resumeLabel?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => void onRun()}
        className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {runLabel}
      </button>
      {canResume && onResume ? (
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => void onResume()}
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {resumeLabel}
        </button>
      ) : null}
    </div>
  );
}

export function DryRunNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-muted-foreground">
      {children} Scheduled runs do not enable GitHub cron from this page. Removal pipeline stays dry-run unless apply
      secrets are configured separately.
    </p>
  );
}
