import { NextResponse } from "next/server";

import {
  allReportsApiWorkerFlags,
  isAmazonReportsApiReimbursementsEnabled,
  isAmazonReportsApiSettlementEnabled,
  isAmazonReportsApiWorkerEnabled,
  reportsApiDisabledReasonForReimbursements,
  reportsApiDisabledReasonForSettlement,
} from "@/lib/amazon/reports-api-worker-flags";
import { buildSourceRunUiSnapshot } from "@/lib/amazon/reports-api-ui";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";

function flagsPayload() {
  const reimbDisabled = reportsApiDisabledReasonForReimbursements();
  const settlementDisabled = reportsApiDisabledReasonForSettlement();
  return {
    worker_enabled: isAmazonReportsApiWorkerEnabled(),
    reimbursements_enabled: isAmazonReportsApiReimbursementsEnabled(),
    settlement_enabled: isAmazonReportsApiSettlementEnabled(),
    disabled_reason: reimbDisabled,
    settlement_disabled_reason: settlementDisabled,
    all_flags: allReportsApiWorkerFlags(),
  };
}

/**
 * GET — feature flags only, or flags + sanitized `source_run` for an upload.
 * Query: `upload_id`, `organization_id` (both required for run snapshot).
 * Never returns credentials or raw credential metadata.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const uploadId = url.searchParams.get("upload_id")?.trim() ?? "";
  const organizationId = url.searchParams.get("organization_id")?.trim() ?? "";

  const flags = flagsPayload();

  if (!uploadId) {
    return NextResponse.json({ ok: true, ...flags });
  }

  if (!isUuidString(uploadId) || !isUuidString(organizationId)) {
    return NextResponse.json(
      { ok: false, error: "upload_id and organization_id must be valid UUIDs." },
      { status: 400 },
    );
  }

  const { data: row, error } = await supabaseServer
    .from("raw_report_uploads")
    .select("id, metadata, status, report_type, file_name")
    .eq("id", uploadId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ ok: false, error: "Upload not found." }, { status: 404 });
  }

  const snapshot = buildSourceRunUiSnapshot({
    uploadId,
    metadata: row.metadata,
  });

  return NextResponse.json({
    ok: true,
    ...flags,
    upload: {
      id: row.id,
      status: row.status,
      report_type: row.report_type,
      file_name: row.file_name,
    },
    source_run: snapshot,
  });
}
