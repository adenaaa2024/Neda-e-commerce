import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { getClaimFilingRequest } from "@/lib/claim-filing-request-handlers";
import { isClaimFilingHandoffApiActive } from "@/lib/claim-filing-handoff";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * GET /api/claims/filing-requests/:id?organization_id=&store_id=&events=1
 */
export async function GET(req: Request, ctx: RouteCtx) {
  if (!isClaimFilingHandoffApiActive()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const { id } = await ctx.params;
  if (!isUuidString(id)) {
    return NextResponse.json({ error: "id must be a UUID." }, { status: 400 });
  }

  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  const includeEvents = ["1", "true", "yes"].includes(
    String(url.searchParams.get("events") ?? "").trim().toLowerCase(),
  );

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const result = await getClaimFilingRequest({
    supabase: supabaseServer,
    userId: gate.userId,
    filingRequestId: id,
    organizationId,
    storeId,
    includeEvents,
  });
  return NextResponse.json(result.body, { status: result.status });
}
