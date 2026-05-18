import { NextResponse } from "next/server";

import { financesApiDisabledReason } from "@/lib/amazon/finances-api-worker-flags";
import { runFinancesApiIngestWorker } from "@/lib/amazon/finances-api-ingest-worker";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  organization_id?: string;
  store_id?: string;
  source_run_id?: string;
  window_start?: string;
  window_end?: string;
  marketplace_id?: string | null;
};

export async function POST(req: Request): Promise<Response> {
  const disabled = financesApiDisabledReason();
  if (disabled) {
    return NextResponse.json(
      {
        ok: false,
        error:
          disabled === "worker_disabled"
            ? "Amazon Finances API worker is disabled (ENABLE_AMAZON_FINANCES_API_WORKER)."
            : "Finances API ingest is disabled (ENABLE_AMAZON_FINANCES_API_INGEST).",
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

  const organizationId = String(body.organization_id ?? "").trim();
  const storeId = String(body.store_id ?? "").trim();
  const sourceRunId = String(body.source_run_id ?? "").trim();

  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return NextResponse.json(
      { ok: false, error: "organization_id and store_id are required UUIDs." },
      { status: 400 },
    );
  }
  if (!isUuidString(sourceRunId)) {
    return NextResponse.json(
      { ok: false, error: "source_run_id is required for resume." },
      { status: 400 },
    );
  }

  const result = await runFinancesApiIngestWorker({
    organizationId,
    storeId,
    marketplaceId: body.marketplace_id ?? null,
    windowStart: String(body.window_start ?? "").trim(),
    windowEnd: String(body.window_end ?? "").trim(),
    sourceRunId,
  });

  return NextResponse.json(
    {
      ok: result.ok,
      source_run_id: result.source_run_id,
      state: result.state,
      needs_resume: result.needs_resume,
      idempotent_replay: result.idempotent_replay ?? false,
      ...(result.error ? { error: result.error } : {}),
      ...(result.error_code ? { code: result.error_code } : {}),
    },
    { status: result.httpStatus },
  );
}
