import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 20;

type Body = { organization_id?: string };
type Ctx = { params: Promise<{ sessionId: string }> };

export async function POST(req: Request, ctx: Ctx) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }
  const organization_id = String(body.organization_id ?? "").trim();
  const { sessionId } = await ctx.params;
  const sid = String(sessionId ?? "").trim();

  if (!isUuidString(organization_id) || !isUuidString(sid)) {
    return NextResponse.json({ ok: false, error: "Invalid ids." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organization_id);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  /** Route param is `raw_report_uploads.id` (same as job id). */
  const job_id = sid;
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
      ? { ...(prevJob as unknown as Record<string, unknown>) }
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

  const { error } = await supabaseServer
    .from("raw_report_uploads")
    .update({
      metadata: meta,
      status: "cancelled",
      updated_at: new Date().toISOString(),
    })
    .eq("id", job_id)
    .eq("organization_id", organization_id);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, job_id, import_session_id: job_id, job_status: "cancelled" });
}
