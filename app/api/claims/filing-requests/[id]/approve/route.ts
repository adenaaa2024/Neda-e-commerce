import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { approveClaimFilingRequest } from "@/lib/claim-filing-request-handlers";
import { isClaimFilingHandoffApiActive } from "@/lib/claim-filing-handoff";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * POST /api/claims/filing-requests/:id/approve
 * Body: { organization_id, store_id }
 */
export async function POST(req: Request, ctx: RouteCtx) {
  if (!isClaimFilingHandoffApiActive()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const { id } = await ctx.params;
  if (!isUuidString(id)) {
    return NextResponse.json({ error: "id must be a UUID." }, { status: 400 });
  }

  let bodyRaw: unknown;
  try {
    bodyRaw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!bodyRaw || typeof bodyRaw !== "object" || Array.isArray(bodyRaw)) {
    return NextResponse.json({ error: "Body must be an object." }, { status: 400 });
  }
  const body = bodyRaw as unknown as Record<string, unknown>;
  const organizationId = String(body.organization_id ?? "").trim();
  const storeId = String(body.store_id ?? "").trim();

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const result = await approveClaimFilingRequest({
    supabase: supabaseServer,
    userId: gate.userId,
    filingRequestId: id,
    organizationId,
    storeId,
  });
  return NextResponse.json(result.body, { status: result.status });
}
