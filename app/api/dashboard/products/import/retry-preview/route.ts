import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { pimEtlRetryPreview } from "@/lib/pim-import-etl-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 30;

type Body = { organization_id?: string; store_id?: string; upload_id?: string };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const organization_id = String(body.organization_id ?? "").trim();
  const store_id = String(body.store_id ?? "").trim();
  const upload_id = String(body.upload_id ?? "").trim();

  if (!isUuidString(organization_id) || !isUuidString(store_id) || !isUuidString(upload_id)) {
    return NextResponse.json({ ok: false, error: "Invalid ids." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organization_id);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const { ok, status, json } = await pimEtlRetryPreview({
    organization_id,
    store_id,
    upload_id,
  });

  return NextResponse.json(json ?? { ok: false, error: "empty_response" }, { status: ok ? 200 : status >= 400 ? status : 502 });
}
