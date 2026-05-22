import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization, userCanRunPimPriceBackfill } from "@/app/dashboard/products/pim-actions";
import { pimEtlPriceBackfillStep } from "@/lib/pim-import-etl-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 125;

export async function POST(req: Request) {
  let body: {
    organization_id?: string;
    upload_id?: string;
    row_chunk?: number | null;
    restart?: boolean;
    cancel?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const organization_id = String(body.organization_id ?? "").trim();
  const upload_id = String(body.upload_id ?? "").trim();
  if (!isUuidString(organization_id) || !isUuidString(upload_id)) {
    return NextResponse.json({ ok: false, error: "Invalid ids." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organization_id);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }
  if (!(await userCanRunPimPriceBackfill(organization_id))) {
    return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
  }

  const r = await pimEtlPriceBackfillStep({
    organization_id,
    upload_id,
    row_chunk: body.row_chunk ?? undefined,
    restart: Boolean(body.restart),
    cancel: Boolean(body.cancel),
  });
  const status = r.timedOut ? 504 : r.status;
  return NextResponse.json(r.json ?? { ok: false, error: "empty_etl_response" }, { status: r.ok ? 200 : status });
}
