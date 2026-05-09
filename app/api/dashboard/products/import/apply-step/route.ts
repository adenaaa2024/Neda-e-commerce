import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { pimEtlApplyStep } from "@/lib/pim-import-etl-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 125;

type Body = {
  organization_id?: string;
  store_id?: string;
  job_id?: string;
  row_chunk?: number | null;
  /** Import safe rows only — skip conflicting rows instead of blocking entire import */
  skip_conflicts?: boolean;
  /** Canonical alias for skip_conflicts — use this name going forward */
  import_safe_rows_only?: boolean;
};

/** FastAPI often returns `{ detail: string | object }` on 4xx/5xx — normalize for the UI. */
function normalizeApplyStepPayload(json: unknown, httpStatus: number): Record<string, unknown> {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const j = json as Record<string, unknown>;
    if ("detail" in j && j.detail != null) {
      const det = j.detail;
      const { detail: _omit, ...rest } = j;
      if (typeof det === "string") {
        return {
          ok: false,
          error: "etl_http_error",
          last_error: det,
          status_code: httpStatus,
          retryable: httpStatus >= 500 || httpStatus === 408 || httpStatus === 504,
          ...rest,
        };
      }
      if (det && typeof det === "object" && !Array.isArray(det)) {
        const d = det as Record<string, unknown>;
        const msg =
          typeof d.message === "string"
            ? d.message
            : typeof (d as { msg?: string }).msg === "string"
              ? String((d as { msg?: string }).msg)
              : JSON.stringify(det).slice(0, 1200);
        return {
          ok: false,
          error: typeof d.error === "string" ? d.error : "etl_http_error",
          last_error: msg,
          status_code: httpStatus,
          retryable: httpStatus >= 500 || httpStatus === 408 || httpStatus === 504,
          ...rest,
        };
      }
    }
    return j;
  }
  return {
    ok: false,
    error: "empty_etl_response",
    last_error: `Empty ETL response (HTTP ${httpStatus}).`,
    status_code: httpStatus,
    retryable: true,
  };
}

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

  const r = await pimEtlApplyStep({
    organization_id,
    store_id,
    upload_id: job_id,
    confirm: "false",
    row_chunk: body.row_chunk,
    // Accept both canonical name and legacy alias
    import_safe_rows_only: body.import_safe_rows_only === true || body.skip_conflicts === true,
    skip_conflicts: body.import_safe_rows_only === true || body.skip_conflicts === true,
  });
  const status = r.timedOut ? 504 : r.status;
  const payload = normalizeApplyStepPayload(r.json ?? null, status);
  return NextResponse.json(payload, { status: r.ok ? 200 : status });
}
