import { NextResponse } from "next/server";

import { gateOrgStoreFromUrl, clampLimit } from "@/lib/claims/center/claim-center-api-shared";
import { TaskCenterApiError } from "@/lib/task-center/task-center-api-handlers";

export async function runTaskCenterGet(
  req: Request,
  handler: (args: {
    organizationId: string;
    storeId: string | null;
    userId: string;
    limit: number;
    url: URL;
  }) => Promise<unknown>,
) {
  const url = new URL(req.url);
  const gate = await gateOrgStoreFromUrl(url);
  if (!gate.ok) return gate.response;

  const limit = clampLimit(url, "limit", 50, 200);
  try {
    const payload = await handler({
      organizationId: gate.organizationId,
      storeId: gate.storeId,
      userId: gate.userId,
      limit,
      url,
    });
    return NextResponse.json(payload);
  } catch (e) {
    if (e instanceof TaskCenterApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : "Request failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
