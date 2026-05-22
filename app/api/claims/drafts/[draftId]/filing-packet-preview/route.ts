import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "../../../../../dashboard/products/pim-actions";
import { buildClaimFilingPacketPreview } from "../../../../../../lib/claim-filing-packet-preview";
import { fetchDraftRow } from "../../../../../../lib/claim-evidence-preview";
import { supabaseServer } from "../../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../../lib/uuid";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await ctx.params;
  if (!isUuidString(draftId)) {
    return NextResponse.json({ error: "Invalid draft id." }, { status: 400 });
  }

  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const draft = await fetchDraftRow(supabaseServer, organizationId, draftId);
  if (!draft) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }

  const logView = url.searchParams.get("log_view") !== "false";
  const packet = await buildClaimFilingPacketPreview(supabaseServer, draft, {
    logView: logView ? { viewedBy: gate.userId } : undefined,
  });

  return NextResponse.json({ ok: true, packet });
}
