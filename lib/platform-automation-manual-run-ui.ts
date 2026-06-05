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

/** True when the server started or queued real work (not a bare 202 with no ids). */
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

export function manualRunAcceptanceMessage(result: Extract<ManualRunPostResult, { ok: true }>): string {
  if (!result.has_execution_evidence) {
    return "Run request was accepted but no runtime record was created.";
  }
  if (result.httpStatus === 202 || result.data.needs_resume) {
    return "Run accepted / started. Check status below.";
  }
  if (result.data.state === "complete") {
    return "Manual run completed.";
  }
  return "Manual run started. Check status below.";
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

  if (opts?.localhostDryRunOnly) {
    return {
      ok: false,
      error: "Local manual run is dry-run only / cannot execute production sync.",
      httpStatus,
      code: "localhost_dry_run_only",
    };
  }

  const hasEvidence = manualRunHasExecutionEvidence(data, httpStatus);

  if (isAutomationManualRunHttpSuccess(httpStatus) && hasEvidence) {
    return {
      ok: true,
      data,
      httpStatus,
      accepted: httpStatus === 202 || Boolean(data.needs_resume),
      has_execution_evidence: true,
    };
  }

  if (isAutomationManualRunHttpSuccess(httpStatus) && !hasEvidence) {
    return {
      ok: false,
      error:
        "Run request returned success HTTP status but no upload/job was created. Check server env flags and SP-API credentials.",
      code: "no_execution_evidence",
      httpStatus,
    };
  }

  if (!res.ok || data.ok === false) {
    const err = String(data.error ?? `Request failed (${httpStatus}).`);
    return {
      ok: false,
      error: err,
      code: typeof data.code === "string" ? data.code : undefined,
      httpStatus,
    };
  }

  return {
    ok: true,
    data,
    httpStatus,
    accepted: false,
    has_execution_evidence: hasEvidence,
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
