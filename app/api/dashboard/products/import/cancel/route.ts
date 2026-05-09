import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 20;

type Body = { organization_id?: string; job_id?: string };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const organization_id = String(body.organization_id ?? "").trim();
  const job_id = String(body.job_id ?? "").trim();

  if (!isUuidString(organization_id) || !isUuidString(job_id)) {
    return NextResponse.json({ ok: false, error: "Invalid ids." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organization_id);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const { data: row, error: fe } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata")
    .eq("id", job_id)
    .eq("organization_id", organization_id)
    .maybeSingle();

  if (fe || !row) {
    return NextResponse.json({ ok: false, error: "Job not found." }, { status: 404 });
  }

  const prev = (row as { metadata?: Record<string, unknown> }).metadata;
  const base = prev && typeof prev === "object" && !Array.isArray(prev) ? { ...prev } : {};
  const prevJob = base.pim_import_job;
  const j =
    typeof prevJob === "object" && prevJob !== null && !Array.isArray(prevJob)
      ? { ...(prevJob as Record<string, unknown>) }
      : {};
  const meta = {
    ...base,
    pim_import_cancelled: true,
    import_job_status: "cancelled",
    preview_status: "cancelled",
    pim_import_job: {
      ...j,
      lifecycle: "cancelled",
      stage_label: "cancelled",
      last_error: "cancelled_by_user",
      preview_phase: null,
      last_step_at: new Date().toISOString(),
    },
  };

  const now = new Date().toISOString();

  const { error } = await supabaseServer
    .from("raw_report_uploads")
    .update({
      metadata: meta,
      status: "cancelled",
      updated_at: now,
    })
    .eq("id", job_id)
    .eq("organization_id", organization_id);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Signal file_processing_status so ETL can detect cancel per-chunk
  try {
    await supabaseServer
      .from("file_processing_status")
      .upsert(
        {
          upload_id: job_id,
          organization_id,
          cancel_requested_at: now,
          cancel_requested_by: gate.userId,
          status: "failed",
        },
        { onConflict: "upload_id" },
      );
  } catch {
    // Non-fatal — cancel was already written to raw_report_uploads.metadata
  }

  return NextResponse.json({ ok: true, job_id, job_status: "cancelled" });
}
