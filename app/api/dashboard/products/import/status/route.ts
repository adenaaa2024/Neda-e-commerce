import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { buildPimImportJobStatusPayload } from "@/lib/pim-import-job-status";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const organization_id = String(url.searchParams.get("organization_id") ?? "").trim();
  const job_id = String(url.searchParams.get("job_id") ?? "").trim();

  if (!isUuidString(organization_id) || !isUuidString(job_id)) {
    return NextResponse.json({ ok: false, error: "Invalid organization_id or job_id." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organization_id);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const { data, error } = await supabaseServer
    .from("raw_report_uploads")
    .select("id,metadata,report_type,updated_at")
    .eq("id", job_id)
    .eq("organization_id", organization_id)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ ok: false, error: error?.message ?? "Job not found." }, { status: 404 });
  }

  const meta = (data as { metadata?: unknown }).metadata as Record<string, unknown>;
  const payload = buildPimImportJobStatusPayload({
    jobId: job_id,
    metadata: meta,
  });

  const job = typeof meta.pim_import_job === "object" && meta.pim_import_job !== null && !Array.isArray(meta.pim_import_job)
    ? (meta.pim_import_job as Record<string, unknown>)
    : {};

  return NextResponse.json({
    ...payload,
    import_session_id: job_id,
    session_status: typeof meta.preview_status === "string" ? meta.preview_status : null,
    session_progress_percent: typeof job.progress_pct === "number" ? job.progress_pct : null,
    session_current_step: typeof job.stage_label === "string" ? job.stage_label : null,
    session_updated_at: typeof data.updated_at === "string" ? data.updated_at : null,
    cancel_requested_at: typeof meta.pim_import_cancelled_at === "string" ? meta.pim_import_cancelled_at : null,
    session_last_error: typeof job.last_error === "string" ? job.last_error : null,
  });
}
