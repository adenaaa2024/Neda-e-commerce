import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { pimEtlPreviewStep } from "@/lib/pim-import-etl-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 125;

type Body = {
  organization_id?: string;
  store_id?: string;
  job_id?: string;
  row_chunk?: number | null;
  scan_data_row_hint?: number | null;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const organization_id = String(body.organization_id ?? "").trim();
  const store_id = String(body.store_id ?? "").trim();
  const job_id = String(body.job_id ?? "").trim();

  if (!isUuidString(organization_id) || !isUuidString(store_id) || !isUuidString(job_id)) {
    return NextResponse.json({ ok: false, error: "Invalid ids." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organization_id);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const r = await pimEtlPreviewStep({
    organization_id,
    store_id,
    upload_id: job_id,
    row_chunk: body.row_chunk,
    scan_data_row_hint: body.scan_data_row_hint,
  });
  const payload = (r.json ?? { ok: false, error: "empty_etl_response" }) as unknown as Record<string, unknown>;
  const retryable = payload.retryable === true;
  const status = r.timedOut ? 504 : r.status;
  if (!r.ok && retryable && status === 503) {
    return NextResponse.json(
      {
        ...payload,
        job_id,
        message:
          typeof payload.message === "string"
            ? payload.message
            : "Transport to ETL dropped — persisted cursor unchanged; retry preview-step.",
      },
      { status: 503 },
    );
  }
  return NextResponse.json(payload, { status: r.ok ? 200 : status });
}
