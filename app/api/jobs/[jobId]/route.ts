import { NextResponse } from "next/server";

import { jobApiBlocked, jobApiError, parseUuidField } from "@/lib/jobs/api-helpers";
import { fetchJobForSession } from "@/lib/jobs/api-session";
import { buildProductEnrichmentJobUiStatus } from "@/lib/jobs/product-enrichment-job-status";

export const runtime = "nodejs";

type Params = { params: Promise<{ jobId: string }> };

export async function GET(_req: Request, ctx: Params): Promise<Response> {
  const { jobId: rawId } = await ctx.params;
  const jobId = parseUuidField(rawId, "job_id");
  if (!jobId) return jobApiError("job_id must be a UUID.");

  try {
    const loaded = await fetchJobForSession(jobId);
    if (!loaded.ok) {
      return NextResponse.json({ ok: false, error: loaded.error }, { status: loaded.status });
    }

    const status =
      loaded.job.job_type === "product_enrichment"
        ? buildProductEnrichmentJobUiStatus(loaded.job, loaded.step)
        : {
            job_id: loaded.job.id,
            status: loaded.job.status,
            progress_pct: loaded.job.progress_pct,
            running: loaded.job.status === "running" || loaded.job.status === "queued",
            needs_tick: loaded.job.status === "running",
            processed: 0,
            total: null,
            failures_count: 0,
            last_cursor_index: null,
            batches_run: 0,
            metrics: null,
            failures: [],
            failed_product_ids: [],
            last_error: loaded.job.last_error_detail,
            cancel_requested: Boolean(loaded.job.cancel_requested_at),
            can_resume: false,
            completed: loaded.job.status === "completed",
          };

    return NextResponse.json({
      ok: true,
      job_id: loaded.job.id,
      job_type: loaded.job.job_type,
      status,
    });
  } catch (e) {
    return jobApiBlocked(e);
  }
}
