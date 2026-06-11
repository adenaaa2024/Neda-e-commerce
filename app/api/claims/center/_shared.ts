import { NextResponse } from "next/server";

import { CenterApiError } from "@/lib/claims/center/claim-center-api-handlers";
import { clampLimit, gateOrgStoreFromUrl } from "@/lib/claims/center/claim-center-api-shared";

export async function runCenterGet(
  req: Request,
  handler: (args: { organizationId: string; storeId: string | null; limit: number; url: URL }) => Promise<unknown>,
) {
  const url = new URL(req.url);
  const gate = await gateOrgStoreFromUrl(url);
  if (!gate.ok) return gate.response;

  const limit = clampLimit(url, "limit", 50, 200);
  try {
    const payload = await handler({
      organizationId: gate.organizationId,
      storeId: gate.storeId,
      limit,
      url,
    });
    return NextResponse.json(payload);
  } catch (e) {
    if (e instanceof CenterApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : "Request failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
