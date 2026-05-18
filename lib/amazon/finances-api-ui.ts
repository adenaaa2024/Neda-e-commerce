/**
 * Client-safe helpers for Finances API archive operator UI (ARCHIVE-04).
 */

import type { AmazonFinancesSourceRunState } from "./finances-api-archive";

export type FinancesApiFlagsStatus = {
  worker_enabled: boolean;
  ingest_enabled: boolean;
  disabled_reason: "worker_disabled" | "ingest_disabled" | null;
};

export type FinancesArchiveCounts = {
  api_pages: number;
  event_groups: number;
  events: number;
};

export type FinancesSourceRunUiSnapshot = {
  source_run_id: string;
  state: AmazonFinancesSourceRunState | "needs_resume" | null;
  display_state: string;
  finances_api_version: string | null;
  phase: string | null;
  window_start: string | null;
  window_end: string | null;
  marketplace_id: string | null;
  store_id: string | null;
  attempt_count: number;
  last_error_code: string | null;
  next_retry_at: string | null;
  last_operation: string | null;
  updated_at: string | null;
  needs_resume: boolean;
  pipeline_complete: boolean;
  pipeline_failed: boolean;
  counts: FinancesArchiveCounts;
};

export type FinancesApiRunStateResponse = {
  ok?: boolean;
  source_run_id?: string | null;
  state?: string | null;
  needs_resume?: boolean;
  idempotent_replay?: boolean;
  error?: string;
  code?: string;
};

export const FINANCES_SOURCE_RUN_STATE_LABELS: Record<string, string> = {
  requested: "Queued",
  polling: "Fetching from Finances API…",
  archived: "Parsing archived pages…",
  complete: "Complete",
  failed: "Failed",
  needs_resume: "Needs resume",
};

const NON_RESUMABLE: AmazonFinancesSourceRunState[] = ["complete", "failed"];

export function financesSourceRunDisplayState(
  state: AmazonFinancesSourceRunState | null,
  needsResumeFlag?: boolean,
): string {
  if (needsResumeFlag && state && !NON_RESUMABLE.includes(state)) return "needs_resume";
  return state ?? "—";
}

export function computeFinancesNeedsResume(
  state: AmazonFinancesSourceRunState | null,
  apiNeedsResume?: boolean,
): boolean {
  if (state === "complete" || state === "failed") return false;
  if (apiNeedsResume === true) return true;
  if (!state) return false;
  return !NON_RESUMABLE.includes(state);
}

export function buildFinancesSourceRunUiSnapshot(params: {
  row: {
    id: string;
    state: string;
    finances_api_version?: string;
    window_start?: string | null;
    window_end?: string | null;
    marketplace_id?: string | null;
    store_id?: string | null;
    updated_at?: string;
    metadata?: Record<string, unknown> | null;
    attempt?: Record<string, unknown> | null;
  };
  counts?: Partial<FinancesArchiveCounts>;
  apiNeedsResume?: boolean;
}): FinancesSourceRunUiSnapshot | null {
  const id = params.row.id?.trim();
  const stateRaw = params.row.state?.trim();
  if (!id || !stateRaw) return null;

  const state = stateRaw as AmazonFinancesSourceRunState;
  const meta = (params.row.metadata ?? {}) as Record<string, unknown>;
  const attempt = (params.row.attempt ?? {}) as Record<string, unknown>;
  const needs_resume = computeFinancesNeedsResume(state, params.apiNeedsResume);

  return {
    source_run_id: id,
    state: needs_resume && state ? "needs_resume" : state,
    display_state: financesSourceRunDisplayState(state, needs_resume),
    finances_api_version: params.row.finances_api_version ?? null,
    phase: typeof meta.phase === "string" ? meta.phase : null,
    window_start: params.row.window_start ?? null,
    window_end: params.row.window_end ?? null,
    marketplace_id: params.row.marketplace_id ?? null,
    store_id: params.row.store_id ?? null,
    attempt_count: typeof attempt.count === "number" ? attempt.count : Number(attempt.count) || 0,
    last_error_code:
      typeof attempt.last_error_code === "string" ? attempt.last_error_code : null,
    next_retry_at: typeof attempt.next_retry_at === "string" ? attempt.next_retry_at : null,
    last_operation: typeof attempt.last_operation === "string" ? attempt.last_operation : null,
    updated_at: params.row.updated_at ?? null,
    needs_resume,
    pipeline_complete: state === "complete",
    pipeline_failed: state === "failed",
    counts: {
      api_pages: params.counts?.api_pages ?? 0,
      event_groups: params.counts?.event_groups ?? 0,
      events: params.counts?.events ?? 0,
    },
  };
}

export { dateInputToWindowIso, defaultReimbursementWindowDates as defaultFinancesWindowDates } from "./reports-api-ui";
