/**
 * Client-safe helpers for Reports API reimbursement UI (NEXT-IMPORT-API-06).
 * No secrets, no server-only imports.
 */

import type { SourceRunState } from "./reports-api-source-run";
import { parseSourceRun } from "./reports-api-source-run";

export type ReportsApiFlagsStatus = {
  worker_enabled: boolean;
  reimbursements_enabled: boolean;
  settlement_enabled: boolean;
  disabled_reason: "worker_disabled" | "reimbursements_disabled" | null;
  settlement_disabled_reason: "worker_disabled" | "settlement_disabled" | null;
};

export type ReportsApiRunStateResponse = {
  ok: boolean;
  upload_id?: string | null;
  source_run_id?: string | null;
  state?: string | null;
  needs_resume?: boolean;
  idempotent_replay?: boolean;
  error?: string;
  code?: string;
};

export type SourceRunUiSnapshot = {
  upload_id: string | null;
  source_run_id: string | null;
  state: SourceRunState | "needs_resume" | null;
  display_state: string;
  report_id: string | null;
  report_document_id: string | null;
  attempt_count: number;
  last_error_code: string | null;
  next_retry_at: string | null;
  window_start: string | null;
  window_end: string | null;
  updated_at: string | null;
  needs_resume: boolean;
  pipeline_complete: boolean;
  pipeline_failed: boolean;
};

export const SOURCE_RUN_STATE_LABELS: Record<string, string> = {
  requested: "Queued",
  polling: "Waiting on Amazon report…",
  downloading: "Downloading report…",
  archived: "Archiving response…",
  synthetic_upload_ready: "Preparing import…",
  staging: "Staging (process)…",
  syncing: "Syncing…",
  generic: "Generic (FRR)…",
  complete: "Complete",
  failed: "Failed",
  needs_resume: "Needs resume",
};

const RESUMABLE_STATES = new Set<SourceRunState>([
  "requested",
  "polling",
  "downloading",
  "archived",
  "synthetic_upload_ready",
  "staging",
  "syncing",
  "generic",
]);

export function sourceRunDisplayState(
  state: SourceRunState | null,
  needsResumeFlag?: boolean,
): string {
  if (needsResumeFlag && state && RESUMABLE_STATES.has(state)) return "needs_resume";
  return state ?? "—";
}

export function computeNeedsResume(
  state: SourceRunState | null,
  apiNeedsResume?: boolean,
): boolean {
  if (state === "complete" || state === "failed") return false;
  if (apiNeedsResume === true) return true;
  if (!state) return false;
  return RESUMABLE_STATES.has(state);
}

export function buildSourceRunUiSnapshot(params: {
  uploadId: string | null;
  metadata: unknown;
  apiNeedsResume?: boolean;
}): SourceRunUiSnapshot | null {
  const sr = parseSourceRun(params.metadata);
  if (!sr && !params.uploadId) return null;

  const state = sr?.state ?? null;
  const needs_resume = computeNeedsResume(state, params.apiNeedsResume);

  return {
    upload_id: params.uploadId,
    source_run_id: sr?.source_run_id ?? null,
    state: needs_resume && state ? "needs_resume" : state,
    display_state: sourceRunDisplayState(state, needs_resume),
    report_id: sr?.external_ids?.report_id ?? null,
    report_document_id: sr?.external_ids?.report_document_id ?? null,
    attempt_count: sr?.attempt?.count ?? 0,
    last_error_code: sr?.attempt?.last_error_code ?? null,
    next_retry_at: sr?.attempt?.next_retry_at ?? null,
    window_start: sr?.window?.start ?? null,
    window_end: sr?.window?.end ?? null,
    updated_at: sr?.updated_at ?? null,
    needs_resume,
    pipeline_complete: state === "complete",
    pipeline_failed: state === "failed",
  };
}

/** `YYYY-MM-DD` → ISO8601 UTC start/end of day for SP-API window. */
export function dateInputToWindowIso(startDate: string, endDate: string): {
  window_start: string;
  window_end: string;
} | { error: string } {
  const s = startDate.trim();
  const e = endDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) {
    return { error: "Start and end dates are required (YYYY-MM-DD)." };
  }
  if (s > e) return { error: "Start date must be on or before end date." };
  return {
    window_start: `${s}T00:00:00.000Z`,
    window_end: `${e}T23:59:59.999Z`,
  };
}

export function defaultReimbursementWindowDates(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}
