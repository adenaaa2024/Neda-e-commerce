import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

import { receiveClaimFilingCallback } from "@/lib/claim-filing-request-handlers";
import { isClaimFilingHandoffApiActive } from "@/lib/claim-filing-handoff";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * POST /api/claims/filing-requests/:id/callback
 * Machine auth: HMAC over raw body (see `lib/claim-filing-handoff-callback.ts`). No session / entitlement.
 */
export async function POST(req: Request, ctx: RouteCtx) {
  if (!isClaimFilingHandoffApiActive()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const { id } = await ctx.params;
  if (!isUuidString(id)) {
    return NextResponse.json({ error: "id must be a UUID." }, { status: 400 });
  }

  const rawBody = await req.text();
  const signatureHeader = req.headers.get("X-Filing-Request-Signature");
  const timestampHeader = req.headers.get("X-Filing-Request-Timestamp");

  const result = await receiveClaimFilingCallback({
    supabase: supabaseServer,
    filingRequestId: id,
    rawBody,
    signatureHeader,
    timestampHeader,
  });
  return NextResponse.json(result.body, { status: result.status });
}
