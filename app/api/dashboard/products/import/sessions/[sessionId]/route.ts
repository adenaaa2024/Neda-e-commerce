import { NextResponse } from "next/server";

import { getPimImportSession } from "@/app/dashboard/products/pim-import-actions";
import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 20;

type Ctx = { params: Promise<{ sessionId: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const url = new URL(req.url);
  const organization_id = String(url.searchParams.get("organization_id") ?? "").trim();
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

  const res = await getPimImportSession({ organizationId: organization_id, sessionId: sid });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: 404 });
  }

  return NextResponse.json({ ok: true, row: res.row });
}
