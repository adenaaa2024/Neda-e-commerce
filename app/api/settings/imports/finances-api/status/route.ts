import { NextResponse } from "next/server";

import { loadFinancesArchiveRunStatus } from "@/lib/amazon/finances-api-status-server";
import {
  financesApiDisabledReason,
  isAmazonFinancesApiIngestEnabled,
  isAmazonFinancesApiWorkerEnabled,
} from "@/lib/amazon/finances-api-worker-flags";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";

function flagsPayload() {
  const disabled = financesApiDisabledReason();
  return {
    worker_enabled: isAmazonFinancesApiWorkerEnabled(),
    ingest_enabled: isAmazonFinancesApiIngestEnabled(),
    disabled_reason: disabled,
  };
}

/**
 * GET — feature flags, or flags + sanitized source run + archive counts.
 * Query: `source_run_id`, `organization_id` (both required for run snapshot).
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sourceRunId = url.searchParams.get("source_run_id")?.trim() ?? "";
  const organizationId = url.searchParams.get("organization_id")?.trim() ?? "";

  const flags = flagsPayload();

  if (!sourceRunId) {
    return NextResponse.json({ ok: true, ...flags });
  }

  if (!isUuidString(sourceRunId) || !isUuidString(organizationId)) {
    return NextResponse.json(
      { ok: false, error: "source_run_id and organization_id must be valid UUIDs." },
      { status: 400 },
    );
  }

  try {
    const status = await loadFinancesArchiveRunStatus(organizationId, sourceRunId);
    if (!status?.snapshot) {
      return NextResponse.json({ ok: false, error: "Source run not found." }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      ...flags,
      source_run: status.snapshot,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Status load failed." },
      { status: 500 },
    );
  }
}
