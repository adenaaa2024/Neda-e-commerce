/**
 * Client-safe manual run route map + POST helpers (no credentials in responses).
 */

export type ImportApiRunResponse = {
  ok?: boolean;
  error?: string;
  code?: string;
  upload_id?: string | null;
  source_run_id?: string | null;
  state?: string | null;
  needs_resume?: boolean;
  job_id?: string;
  status?: string;
  runtime_status?: string | null;
};

export const AUTOMATION_MANUAL_RUN_ROUTES = {
  reimbursements_run: "/api/settings/imports/reports-api/run",
  reimbursements_resume: "/api/settings/imports/reports-api/resume",
  settlement_run: "/api/settings/imports/reports-api/settlement/run",
  settlement_resume: "/api/settings/imports/reports-api/settlement/resume",
  finances_run: "/api/settings/imports/finances-api/run",
  finances_resume: "/api/settings/imports/finances-api/resume",
  removal_order_run: "/api/settings/imports/reports-api/removal-order/run",
  removal_order_resume: "/api/settings/imports/reports-api/removal-order/resume",
  removal_shipment_run: "/api/settings/imports/reports-api/removal-shipment/run",
  removal_shipment_resume: "/api/settings/imports/reports-api/removal-shipment/resume",
  jobs_enqueue: "/api/jobs/enqueue",
} as const;

export type ManualRunPostResult =
  | { ok: true; data: ImportApiRunResponse; httpStatus: number; accepted: boolean; has_execution_evidence: boolean }
  | { ok: false; error: string; code?: string; httpStatus: number };

const INACTIVE_STATES = new Set(["failed", "unknown", "skipped", "skipped_report_type", ""]);

const RESUMABLE_STATES = new Set([
  "requested",
  "polling",
  "downloading",
  "synthetic_upload_ready",
  "staging",
  "syncing",
  "generic",
]);

export function isTerminalManualRunState(state: string | null | undefined): boolean {
  const s = String(state ?? "")
    .trim()
    .toLowerCase();
  return s === "complete" || s === "failed" || s === "synced";
}

export function manualRunNeedsClientDrain(data: ImportApiRunResponse): boolean {
  if (data.needs_resume) return true;
  const state = String(data.state ?? data.runtime_status ?? data.status ?? "")
    .trim()
    .toLowerCase();
  return RESUMABLE_STATES.has(state);
}

export type ManualRunDrainResult =
  | {
      ok: true;
      final: Extract<ManualRunPostResult, { ok: true }>;
      steps: number;
      terminal_state: string | null;
    }
  | {
      ok: false;
      error: string;
      last?: ManualRunPostResult;
      steps: number;
      needs_manual_resume: boolean;
      state: string | null;
    };

/** Poll run/resume until terminal import state or max_runtime_seconds. */
export async function drainAutomationManualImportRun(args: {
  runUrl: string;
  resumeUrl: string;
  runBody: Record<string, unknown>;
  organizationId: string;
  maxRuntimeSeconds: number;
  localhostDryRunOnly?: boolean;
  intervalMs?: number;
}): Promise<ManualRunDrainResult> {
  const deadline = Date.now() + Math.max(5, args.maxRuntimeSeconds) * 1000;
  const intervalMs = args.intervalMs ?? 2500;
  let steps = 0;
  let uploadId: string | null = null;

  const post = (url: string, body: Record<string, unknown>) =>
    postAutomationManualRun(url, { ...body, run_pipeline: true }, {
      localhostDryRunOnly: args.localhostDryRunOnly,
    });

  let result = await post(args.runUrl, args.runBody);
  steps += 1;
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      last: result,
      steps,
      needs_manual_resume: false,
      state: null,
    };
  }

  let patch = manualRunStateFromResponse(result.data);
  uploadId = patch.upload_id;

  while (Date.now() < deadline) {
    const state = patch.state;
    if (isTerminalManualRunState(state) && !patch.needs_resume) {
      return {
        ok: true,
        final: result,
        steps,
        terminal_state: state,
      };
    }
    if (!manualRunNeedsClientDrain(result.data) && !patch.needs_resume) {
      return {
        ok: true,
        final: result,
        steps,
        terminal_state: state,
      };
    }
    if (!uploadId) break;

    await new Promise((r) => setTimeout(r, intervalMs));
    result = await post(args.resumeUrl, {
      organization_id: args.organizationId,
      upload_id: uploadId,
    });
    steps += 1;
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        last: result,
        steps,
        needs_manual_resume: true,
        state: patch.state,
      };
    }
    patch = manualRunStateFromResponse(result.data);
    uploadId = patch.upload_id ?? uploadId;
  }

  const state = patch.state;
  const needsResume = patch.needs_resume || manualRunNeedsClientDrain(result.data);
  return {
    ok: false,
    error: needsResume
      ? `Import did not finish within ${args.maxRuntimeSeconds}s (last state: ${state ?? "unknown"}). Click Resume to continue the import.`
      : `Import stopped after ${args.maxRuntimeSeconds}s (state: ${state ?? "unknown"}).`,
    last: result.ok ? result : undefined,
    steps,
    needs_manual_resume: needsResume,
    state,
  };
}

export function manualRunCompletionMessage(input: {
  drain: ManualRunDrainResult;
  label: string;
}): string {
  const { drain, label } = input;
  if (drain.ok) {
    const state = String(drain.terminal_state ?? drain.final.data.state ?? "").toLowerCase();
    if (state === "failed") {
      return `${label} import failed. See status below.`;
    }
    return `${label} import completed (${state || "done"}).`;
  }
  if (drain.needs_manual_resume) {
    const state = String(drain.state ?? "in progress").toLowerCase();
    if (state === "synthetic_upload_ready") {
      return `${label}: report ready — auto-resume timed out. Click Resume to run the import pipeline.`;
    }
    return `${label}: ${drain.error}`;
  }
  return drain.error;
}

/** @deprecated Prefer manualRunCompletionMessage after drain. */
export function manualRunHasExecutionEvidence(data: ImportApiRunResponse, httpStatus: number): boolean {
  if (httpStatus >= 400) return false;

  const hasId = Boolean(
    String(data.upload_id ?? "").trim() ||
      String(data.source_run_id ?? "").trim() ||
      String(data.job_id ?? "").trim(),
  );
  const state = String(data.state ?? data.runtime_status ?? data.status ?? "")
    .trim()
    .toLowerCase();
  const activeState = Boolean(state && !INACTIVE_STATES.has(state));

  if (hasId) return true;
  if (httpStatus === 200 && data.ok === true) return true;
  if (httpStatus === 202 && activeState && data.needs_resume) return true;
  if (httpStatus === 202 && activeState) return true;

  return false;
}

export function isAutomationManualRunHttpSuccess(status: number): boolean {
  return status >= 200 && status <= 202;
}

export function manualRunAcceptanceMessage(
  result: Extract<ManualRunPostResult, { ok: true }>,
  opts?: { localhostQueuedOnly?: boolean },
): string {
  const state = String(result.data.state ?? result.data.runtime_status ?? "").toLowerCase();
  if (result.httpStatus === 202 || result.accepted) {
    if (opts?.localhostQueuedOnly) {
      return "Run accepted on local dev (queued / in progress). This is not a production cron run — check status below.";
    }
    if (!result.has_execution_evidence) {
      return "Run accepted / started. Check status below.";
    }
    if (isTerminalManualRunState(state) && !result.data.needs_resume) {
      return state === "failed" ? "Manual run failed. See status below." : "Manual run completed.";
    }
    return "Run accepted / started. Check status below.";
  }
  if (!result.has_execution_evidence) {
    return "Run request was accepted but no runtime record was created.";
  }
  if (isTerminalManualRunState(state) && !result.data.needs_resume) {
    return state === "failed" ? "Manual run failed. See status below." : "Manual run completed.";
  }
  if (state === "synthetic_upload_ready" || result.data.needs_resume) {
    return "Step 1 complete (report ready). Continuing import…";
  }
  return "Manual run in progress…";
}

export async function postAutomationManualRun(
  url: string,
  body: Record<string, unknown>,
  opts?: { localhostDryRunOnly?: boolean },
): Promise<ManualRunPostResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  let data: ImportApiRunResponse = {};
  try {
    data = (await res.json()) as ImportApiRunResponse;
  } catch {
    data = {};
  }

  const httpStatus = res.status;
  const hasEvidence = manualRunHasExecutionEvidence(data, httpStatus);

  // HTTP 200–202 are success. JSON `ok: false` means import not finished yet (common on 202), not request failure.
  if (isAutomationManualRunHttpSuccess(httpStatus)) {
    const accepted = httpStatus >= 202 || Boolean(data.needs_resume);
    if (opts?.localhostDryRunOnly && !hasEvidence && !accepted) {
      return {
        ok: false,
        error:
          "Local manual run could not start — missing production env (CRON_SECRET, ORIGINAL_DIRECT_POSTGRES_URL, or production Supabase URL).",
        httpStatus,
        code: "localhost_dry_run_only",
      };
    }
    return {
      ok: true,
      data,
      httpStatus,
      accepted,
      has_execution_evidence: hasEvidence,
    };
  }

  const err = String(data.error ?? `Request failed (${httpStatus}).`);
  return {
    ok: false,
    error: err,
    code: typeof data.code === "string" ? data.code : undefined,
    httpStatus,
  };
}

export async function pollAutomationRuntimeRefresh<T>(
  refresh: () => Promise<T | null | undefined>,
  opts?: { attempts?: number; intervalMs?: number },
): Promise<T | null> {
  const attempts = opts?.attempts ?? 3;
  const intervalMs = opts?.intervalMs ?? 2500;
  let last: T | null = null;
  last = (await refresh()) ?? null;
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = (await refresh()) ?? last;
  }
  return last;
}

export function manualRunStateFromResponse(data: ImportApiRunResponse): {
  upload_id: string | null;
  source_run_id: string | null;
  needs_resume: boolean;
  state: string | null;
  active_job_id: string | null;
  job_status: string | null;
} {
  return {
    upload_id: data.upload_id ?? null,
    source_run_id: data.source_run_id ?? null,
    needs_resume: Boolean(data.needs_resume),
    state: data.state ?? data.runtime_status ?? null,
    active_job_id: data.job_id ?? null,
    job_status: data.status ?? null,
  };
}

export function isLocalhostDryRunOnly(
  runEnvironment: { manual_run_may_queue_only?: boolean } | null | undefined,
  isLocalhost: boolean,
): boolean {
  return isLocalhost && Boolean(runEnvironment?.manual_run_may_queue_only);
}

export function removalRuntimeStillEmpty(runtime: {
  last_run_at: string | null;
  last_run_status: string;
}): boolean {
  return !runtime.last_run_at && runtime.last_run_status === "never";
}

export function featureFlagBlockedMessage(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  if (code === "localhost_dry_run_only") {
    return "Local manual run is dry-run only / cannot execute production sync.";
  }
  if (code === "no_execution_evidence") {
    return "Run request was accepted but no runtime record was created.";
  }
  if (code === "worker_disabled" || code === "reports_worker_disabled") {
    return "Amazon Reports API worker is disabled on the server. Enable ENABLE_AMAZON_REPORTS_API_WORKER.";
  }
  if (code === "reimbursements_disabled") {
    return "Reimbursements report is disabled. Enable ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS.";
  }
  if (code === "settlement_disabled") {
    return "Settlement report is disabled. Enable ENABLE_AMAZON_REPORTS_API_SETTLEMENT.";
  }
  if (code === "removal_order_disabled" || code === "removal_shipment_disabled") {
    return "Removal reports are disabled on the server.";
  }
  if (code === "worker_disabled" && fallback.includes("Finances")) {
    return "Finances API worker is disabled. Enable ENABLE_AMAZON_FINANCES_API_WORKER and ENABLE_AMAZON_FINANCES_API_INGEST.";
  }
  return fallback;
}
