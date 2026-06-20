import { NextResponse } from "next/server";

import { runInboundPerformanceReportsWorker } from "@/lib/amazon/reports-api-inbound-performance-worker";
import { reportsApiDisabledReasonForInboundPerformance } from "@/lib/amazon/reports-api-worker-flags";
import { auditPlatformAutomationManualRun } from "@/lib/platform-automation-manual-run-audit";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  organization_id?: string;
  store_id?: string;
  window_start?: string;
  window_end?: string;
  actor_user_id?: string | null;
  upload_id?: string | null;
};

export async function POST(req: Request): Promise<Response> {
  const disabled = reportsApiDisabledReasonForInboundPerformance();
  if (disabled) {
    return NextResponse.json(
      {
        ok: false,
        error:
          disabled === "worker_disabled"
            ? "Amazon Reports API worker is disabled (ENABLE_AMAZON_REPORTS_API_WORKER)."
            : "GET_FBA_FULFILLMENT_INBOUND_PERFORMANCE_DATA is disabled (ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE).",
        code: disabled,
      },
      { status: 503 },
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const organizationId = String(body.organization_id ?? "").trim();
  const storeId = String(body.store_id ?? "").trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return NextResponse.json(
      { ok: false, error: "organization_id and store_id are required UUIDs." },
      { status: 400 },
    );
  }

  const result = await runInboundPerformanceReportsWorker({
    organizationId,
    storeId,
    windowStart: String(body.window_start ?? "").trim(),
    windowEnd: String(body.window_end ?? "").trim(),
    actorUserId: body.actor_user_id ?? null,
    uploadId: body.upload_id ?? null,
  });

  void auditPlatformAutomationManualRun({
    organizationId,
    storeId,
    automationType: "inbound_performance",
    action: "run_now",
    requestBody: { window_start: body.window_start, window_end: body.window_end, upload_id: body.upload_id },
    result: { ok: result.ok, upload_id: result.upload_id, source_run_id: result.source_run_id, state: result.state, needs_resume: result.needs_resume, http_status: result.httpStatus },
    route: "/api/settings/imports/reports-api/inbound-performance/run",
  });

  return NextResponse.json(
    {
      ok: result.ok,
      upload_id: result.upload_id,
      source_run_id: result.source_run_id,
      state: result.state,
      needs_resume: result.needs_resume,
      idempotent_replay: result.idempotent_replay ?? false,
      ...(result.error ? { error: result.error } : {}),
      ...(result.error_code ? { code: result.error_code } : {}),
    },
    { status: result.httpStatus },
  );
}
