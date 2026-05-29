import { NextResponse } from "next/server";

import { jobApiBlocked, jobApiError, parseUuidField } from "@/lib/jobs/api-helpers";
import { retryJob } from "@/lib/jobs/orchestrator";
import { supabaseServer } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  job_id?: string;
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
    const result = await retryJob(supabaseServer, jobId);
    return NextResponse.json({
      ok: result.ok,
      job_id: result.jobId,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (e) {
    return jobApiBlocked(e);
  }
}
