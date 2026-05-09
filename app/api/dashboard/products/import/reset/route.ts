import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { resetPimImportJobState } from "@/app/dashboard/products/pim-import-actions";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 20;

type Body = { organization_id?: string; job_id?: string };

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

  const r = await resetPimImportJobState({ organizationId: organization_id, uploadId: job_id });
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
