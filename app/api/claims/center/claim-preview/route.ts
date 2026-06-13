import { NextResponse } from "next/server";

import { getCenterClaimPreviewPayload } from "@/lib/claims/center/claim-center-api-handlers";
import { runCenterGet } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!storeId) {
    return NextResponse.json(
      { error: "store_id is required for claim preview readmodel." },
      { status: 400 },
    );
  }

  return runCenterGet(req, async ({ organizationId, storeId: gatedStoreId, limit, url: u }) =>
    getCenterClaimPreviewPayload({
      organizationId,
      storeId: gatedStoreId!,
      limit,
      from: u.searchParams.get("from"),
      to: u.searchParams.get("to"),
      family: u.searchParams.get("family"),
    }),
  );
}
