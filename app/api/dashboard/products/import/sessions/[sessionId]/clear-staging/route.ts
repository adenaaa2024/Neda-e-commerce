import { NextResponse } from "next/server";

import { clearPimImportSessionStaging } from "@/app/dashboard/products/pim-import-actions";
import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 30;

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

  const res = await clearPimImportSessionStaging({ organizationId: organization_id, sessionId: sid });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
