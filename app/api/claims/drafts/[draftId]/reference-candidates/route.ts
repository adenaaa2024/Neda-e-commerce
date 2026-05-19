import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "../../../../../dashboard/products/pim-actions";
import { buildReferenceCandidatesResponseForDraftId } from "../../../../../../lib/claim-reference-candidates";
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

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.min(120, Math.max(1, Number(limitRaw) || 80)) : undefined;

  const body = await buildReferenceCandidatesResponseForDraftId(
    supabaseServer,
    organizationId,
    draftId,
    { limit },
  );

  if (!body) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }

  return NextResponse.json(body);
}
