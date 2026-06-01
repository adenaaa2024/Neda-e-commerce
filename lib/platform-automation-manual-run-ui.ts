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
  | { ok: true; data: ImportApiRunResponse; httpStatus: number }
  | { ok: false; error: string; code?: string; httpStatus: number };

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

  if (!res.ok || data.ok === false) {
    const err = String(data.error ?? `Request failed (${res.status}).`);
    return {
      ok: false,
      error: err,
      code: typeof data.code === "string" ? data.code : undefined,
      httpStatus: res.status,
    };
  }

  return { ok: true, data, httpStatus: res.status };
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
