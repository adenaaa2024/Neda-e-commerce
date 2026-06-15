import { NextResponse } from "next/server";

import { getCenterPreviewGeneratorsPayload } from "@/lib/claims/center/claim-center-api-handlers";
import { runCenterGet } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!storeId) {
    return NextResponse.json(
      { error: "store_id is required for preview generators." },
      { status: 400 },
    );
  }

  return runCenterGet(req, async ({ organizationId, storeId: gatedStoreId, limit, url: u }) =>
    getCenterPreviewGeneratorsPayload({
      organizationId,
      storeId: gatedStoreId!,
      limit,
      from: u.searchParams.get("from"),
      to: u.searchParams.get("to"),
    }),
  );
}
