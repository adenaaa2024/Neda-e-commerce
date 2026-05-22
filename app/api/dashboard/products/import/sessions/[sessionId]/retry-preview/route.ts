import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { pimEtlRetryPreview } from "@/lib/pim-import-etl-server";
import { supabaseServer } from "@/lib/supabase-server";
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

  const { data: rawUp, error } = await supabaseServer
    .from("raw_report_uploads")
    .select("id,metadata")
    .eq("id", sid)
    .eq("organization_id", organization_id)
    .maybeSingle();

  if (error || !rawUp) {
    return NextResponse.json({ ok: false, error: error?.message ?? "Upload not found." }, { status: 404 });
  }

  const upload_id = String((rawUp as { id?: string }).id ?? "").trim();
  const m = ((rawUp as { metadata?: Record<string, unknown> }).metadata ?? {}) as unknown as Record<string, unknown>;
  const store_id = String(m.import_store_id ?? m.ledger_store_id ?? m.store_id ?? "").trim();
  if (!isUuidString(upload_id) || !isUuidString(store_id)) {
    return NextResponse.json({ ok: false, error: "Invalid upload metadata (store id)." }, { status: 400 });
  }

  const { ok, status, json } = await pimEtlRetryPreview({
    organization_id,
    store_id,
    upload_id,
  });

  return NextResponse.json(json ?? { ok: false, error: "empty_response" }, { status: ok ? 200 : status >= 400 ? status : 502 });
}
