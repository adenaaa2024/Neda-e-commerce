import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 20;

type Body = { organization_id?: string; job_id?: string; import_safe_rows_only?: boolean };

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
    .select("metadata,status")
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
  if (base.pim_import_cancelled === true || String(j.lifecycle ?? "").toLowerCase() === "cancelled") {
    return NextResponse.json({ ok: false, error: "This import was cancelled." }, { status: 409 });
  }
  const previewSt = String(base.preview_status ?? "").toLowerCase();
  const life = String((j as { lifecycle?: string }).lifecycle ?? "").toLowerCase();
  const previewReady =
    previewSt === "preview_ready" || life === "waiting_for_confirmation" || life === "preview_ready";
  if (!previewReady) {
    return NextResponse.json(
      { ok: false, error: "Preview is not ready for this session — finish preview or resume the job first." },
      { status: 409 },
    );
  }

  const pq =
    typeof j.preview_quality === "object" && j.preview_quality !== null && !Array.isArray(j.preview_quality)
      ? (j.preview_quality as Record<string, unknown>)
      : null;
  if (pq?.apply_blocked_by_dirty_rate === true) {
    return NextResponse.json(
      { ok: false, error: "Import blocked: dirty rate exceeds the allowed threshold for this preview." },
      { status: 422 },
    );
  }
  if (pq?.apply_blocked_by_conflicts === true) {
    // Allow "Import safe rows only" to bypass this check — conflicts are skipped during apply
    if (!(body as { import_safe_rows_only?: boolean }).import_safe_rows_only) {
      return NextResponse.json(
        { ok: false, error: "Import blocked: preview has blocking identifier conflicts." },
        { status: 422 },
      );
    }
  }

  const meta = {
    ...base,
    pim_import_confirmed: true,
    pim_import_confirmed_at: new Date().toISOString(),
    import_job_status: "import_queued",
    pim_import_job: {
      ...j,
      lifecycle: "import_queued",
      stage_label: "import_queued",
      last_step_at: new Date().toISOString(),
    },
  };

  const { error } = await supabaseServer
    .from("raw_report_uploads")
    .update({
      metadata: meta,
      updated_at: new Date().toISOString(),
    })
    .eq("id", job_id)
    .eq("organization_id", organization_id);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, job_id, job_status: "import_queued" });
}
