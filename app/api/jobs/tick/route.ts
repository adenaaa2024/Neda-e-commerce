import { NextResponse } from "next/server";

import { jobApiBlocked, jobApiError, parseUuidField, runtime, maxDuration } from "@/lib/jobs/api-helpers";
import { tickJob } from "@/lib/jobs/orchestrator";
import { supabaseServer } from "@/lib/supabase-server";

export { runtime, maxDuration };

type Body = {
  job_id?: string;
  worker_instance_id?: string;
};

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jobApiError("Invalid JSON body.");
  }

  const jobId = parseUuidField(body.job_id, "job_id");
  if (!jobId) return jobApiError("job_id must be a UUID.");

  try {
    const result = await tickJob(
      supabaseServer,
      jobId,
      String(body.worker_instance_id ?? "api-tick").trim() || "api-tick",
    );

    return NextResponse.json({
      ok: result.ok,
      job_id: result.jobId,
      status: result.status,
      progress_pct: result.progressPct,
      needs_tick: result.needsTick,
      current_step_index: result.currentStepIndex,
      ...(result.errorCode ? { code: result.errorCode } : {}),
      ...(result.errorDetail ? { error: result.errorDetail } : {}),
    });
  } catch (e) {
    return jobApiBlocked(e);
  }
}
