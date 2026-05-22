/**
 * Import History helpers — source_run badge + filters (NEXT-IMPORT-API-07).
 * Client-safe: no secrets, no server-only.
 */

import { AMAZON_LEDGER_UPLOAD_SOURCE } from "../raw-report-upload-metadata";
import type { RawReportUploadRow } from "../raw-report-upload-row";
import {
  buildSourceRunUiSnapshot,
  SOURCE_RUN_STATE_LABELS,
  type SourceRunUiSnapshot,
} from "./reports-api-ui";

/** Written by Reports API synthetic upload (`reports-api-synthetic-upload.ts`). */
export const AMAZON_REPORTS_API_UPLOAD_SOURCE = "amazon_reports_api" as const;

export type ImportHistoryOrigin = "api" | "manual" | "ledger";

export type ImportHistoryFilter = "all" | "api" | "manual" | "failed" | "needs_resume";

export type ImportHistorySourceRunView = {
  origin: ImportHistoryOrigin;
  sourceRun: SourceRunUiSnapshot | null;
  /** Human label for badge (source run state or upload status). */
  badgeLabel: string;
  badgeTone: "neutral" | "active" | "success" | "warning" | "danger";
  showSourceRunBadge: boolean;
  isFailed: boolean;
  needsResume: boolean;
};

export const IMPORT_HISTORY_FILTER_LABELS: Record<ImportHistoryFilter, string> = {
  all: "All",
  api: "API pull",
  manual: "Manual upload",
  failed: "Failed",
  needs_resume: "Needs resume",
};

function readMetadata(row: RawReportUploadRow): Record<string, unknown> | null {
  const m = row.metadata;
  if (m && typeof m === "object" && !Array.isArray(m)) return m;
  return null;
}

export function importHistoryOrigin(row: RawReportUploadRow): ImportHistoryOrigin {
  const meta = readMetadata(row);
  if (!meta) return "manual";
  const source = typeof meta.source === "string" ? meta.source.trim() : "";
  if (source === AMAZON_LEDGER_UPLOAD_SOURCE) return "ledger";
  if (source === AMAZON_REPORTS_API_UPLOAD_SOURCE) return "api";
  const snap = buildSourceRunUiSnapshot({ uploadId: row.id, metadata: meta });
  if (snap?.source_run_id) return "api";
  return "manual";
}

export function buildImportHistorySourceRunView(row: RawReportUploadRow): ImportHistorySourceRunView {
  const meta = readMetadata(row);
  const origin = importHistoryOrigin(row);
  const sourceRun = buildSourceRunUiSnapshot({ uploadId: row.id, metadata: meta });

  const uploadFailed = row.status === "failed" || row.status === "error";
  const runFailed = sourceRun?.pipeline_failed === true;
  const isFailed = uploadFailed || runFailed;

  const needsResume = sourceRun?.needs_resume === true;

  const showSourceRunBadge = origin === "api" && sourceRun != null;

  let badgeLabel = "Manual";
  let badgeTone: ImportHistorySourceRunView["badgeTone"] = "neutral";

  if (origin === "ledger") {
    badgeLabel = "Ledger session";
    badgeTone = "neutral";
  } else if (showSourceRunBadge && sourceRun) {
    const display = sourceRun.display_state;
    const stateLabel = SOURCE_RUN_STATE_LABELS[display] ?? display;
    const srReportType =
      meta && typeof meta.source_run === "object" && meta.source_run !== null
        ? String((meta.source_run as { report_type?: string }).report_type ?? "")
        : "";
    const isSettlement =
      row.report_type === "SETTLEMENT" || srReportType.includes("SETTLEMENT");
    badgeLabel = isSettlement ? `Settlement · ${stateLabel}` : stateLabel;
    if (display === "complete") badgeTone = "success";
    else if (display === "failed") badgeTone = "danger";
    else if (display === "needs_resume") badgeTone = "warning";
    else badgeTone = "active";
  } else if (origin === "api") {
    badgeLabel = "Reports API";
    badgeTone = "active";
  }

  return {
    origin,
    sourceRun,
    badgeLabel,
    badgeTone,
    showSourceRunBadge,
    isFailed,
    needsResume,
  };
}

export function matchesImportHistoryFilter(
  row: RawReportUploadRow,
  filter: ImportHistoryFilter,
  view?: ImportHistorySourceRunView,
): boolean {
  if (filter === "all") return true;
  const v = view ?? buildImportHistorySourceRunView(row);
  switch (filter) {
    case "api":
      return v.origin === "api";
    case "manual":
      return v.origin === "manual" || v.origin === "ledger";
    case "failed":
      return v.isFailed;
    case "needs_resume":
      return v.needsResume;
    default:
      return true;
  }
}

export function filterImportHistoryRows(
  rows: RawReportUploadRow[],
  filter: ImportHistoryFilter,
  searchQuery: string,
): RawReportUploadRow[] {
  const q = searchQuery.trim().toLowerCase();
  return rows.filter((row) => {
    if (!matchesImportHistoryFilter(row, filter)) return false;
    if (!q) return true;
    const v = buildImportHistorySourceRunView(row);
    return (
      row.file_name.toLowerCase().includes(q) ||
      (row.report_type ?? "").toLowerCase().includes(q) ||
      (v.sourceRun?.report_id ?? "").toLowerCase().includes(q) ||
      (v.sourceRun?.source_run_id ?? "").toLowerCase().includes(q) ||
      v.badgeLabel.toLowerCase().includes(q)
    );
  });
}

export function sourceRunBadgeClassName(tone: ImportHistorySourceRunView["badgeTone"]): string {
  switch (tone) {
    case "success":
      return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300";
    case "warning":
      return "bg-amber-500/15 text-amber-900 dark:text-amber-200";
    case "danger":
      return "bg-destructive/15 text-destructive";
    case "active":
      return "bg-sky-500/15 text-sky-800 dark:text-sky-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}
