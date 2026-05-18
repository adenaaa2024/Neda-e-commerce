import { NextResponse } from "next/server";

import { reportsApiDisabledReasonForSettlement } from "@/lib/amazon/reports-api-worker-flags";
import { runSettlementReportsWorker } from "@/lib/amazon/reports-api-settlement-worker";
import { parseSourceRun } from "@/lib/amazon/reports-api-source-run";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  upload_id?: string;
  organization_id?: string;
};

export async function POST(req: Request): Promise<Response> {
  const disabled = reportsApiDisabledReasonForSettlement();
  if (disabled) {
    return NextResponse.json(
      {
        ok: false,
        error: "Reports API settlement worker is disabled.",
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

  const uploadId = String(body.upload_id ?? "").trim();
  const organizationId = String(body.organization_id ?? "").trim();
  if (!isUuidString(uploadId) || !isUuidString(organizationId)) {
    return NextResponse.json(
      { ok: false, error: "upload_id and organization_id are required UUIDs." },
      { status: 400 },
    );
  }

  const { data: row, error } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata, organization_id")
    .eq("id", uploadId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error || !row) {
    return NextResponse.json({ ok: false, error: "Upload not found." }, { status: 404 });
  }

  const sourceRun = parseSourceRun(row.metadata);
  if (!sourceRun?.window || !sourceRun.store_id) {
    return NextResponse.json(
      { ok: false, error: "Upload is missing metadata.source_run window or store_id." },
      { status: 422 },
    );
  }

  const result = await runSettlementReportsWorker({
    organizationId,
    storeId: sourceRun.store_id,
    windowStart: sourceRun.window.start,
    windowEnd: sourceRun.window.end,
    uploadId,
  });

  return NextResponse.json(
    {
      ok: result.ok,
      upload_id: result.upload_id,
      source_run_id: result.source_run_id,
      state: result.state,
      needs_resume: result.needs_resume,
      ...(result.error ? { error: result.error } : {}),
      ...(result.error_code ? { code: result.error_code } : {}),
    },
    { status: result.httpStatus },
  );
}
