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
  | { ok: true; data: ImportApiRunResponse; httpStatus: number; accepted: boolean }
  | { ok: false; error: string; code?: string; httpStatus: number };

/** 200–202 are success for async report workers (202 = accepted / in progress). */
export function isAutomationManualRunHttpSuccess(status: number): boolean {
  return status >= 200 && status <= 202;
}

export function manualRunAcceptanceMessage(result: Extract<ManualRunPostResult, { ok: true }>): string {
  if (result.httpStatus === 202 || result.data.needs_resume) {
    return "Run accepted / started. Check status below.";
  }
  if (result.data.state === "complete") {
    return "Manual run completed.";
  }
  if (result.accepted) {
    return "Run accepted by server. Check status below.";
  }
  return "Manual run accepted by server.";
}

export async function postAutomationManualRun(
  url: string,
  body: Record<string, unknown>,
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
  const httpSuccess = isAutomationManualRunHttpSuccess(httpStatus);
  const inProgress = httpStatus === 202 || data.needs_resume === true;

  if (httpSuccess && (inProgress || data.ok !== false)) {
    return {
      ok: true,
      data,
      httpStatus,
      accepted: inProgress || httpStatus === 202,
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

  return { ok: true, data, httpStatus, accepted: false };
}

/** Refresh runtime stats a few times after async 202 acceptance. */
export async function pollAutomationRuntimeRefresh(
  refresh: () => Promise<void>,
  opts?: { attempts?: number; intervalMs?: number },
): Promise<void> {
  const attempts = opts?.attempts ?? 3;
  const intervalMs = opts?.intervalMs ?? 2500;
  await refresh();
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    await refresh();
  }
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
    state: data.state ?? null,
    active_job_id: data.job_id ?? null,
    job_status: data.status ?? null,
  };
}

export function featureFlagBlockedMessage(code: string | undefined, fallback: string): string {
  if (!code) return fallback;
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
