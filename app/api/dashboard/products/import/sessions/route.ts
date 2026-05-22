import { NextResponse } from "next/server";

import { listPimImportSessions } from "@/app/dashboard/products/pim-import-actions";
import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 20;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const organization_id = String(url.searchParams.get("organization_id") ?? "").trim();
  const store_id = String(url.searchParams.get("store_id") ?? "").trim();
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  if (!isUuidString(organization_id)) {
    return NextResponse.json({ ok: false, error: "Invalid organization_id." }, { status: 400 });
  }
  if (store_id && !isUuidString(store_id)) {
    return NextResponse.json({ ok: false, error: "Invalid store_id." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organization_id);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const res = await listPimImportSessions({
    organizationId: organization_id,
    ...(store_id ? { storeId: store_id } : {}),
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    rows: res.rows,
    unlinked_rows: res.unlinkedRows,
    ensure: res.ensureStats,
    suggested_active: res.suggestedActive,
  });
}
