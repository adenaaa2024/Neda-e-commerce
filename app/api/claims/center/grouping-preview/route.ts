import { NextResponse } from "next/server";

import { getCenterGroupingPreviewPayload } from "@/lib/claims/center/claim-center-api-handlers";
import { parseGroupingFiltersFromSearchParams } from "@/lib/claims/grouping/claim-grouping-readmodel";
import { runCenterGet } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!storeId) {
    return NextResponse.json(
      { error: "store_id is required for grouping preview." },
      { status: 400 },
    );
  }

  return runCenterGet(req, async ({ organizationId, storeId: gatedStoreId, url: u }) => {
    const filters = parseGroupingFiltersFromSearchParams(organizationId, gatedStoreId!, u.searchParams);
    return getCenterGroupingPreviewPayload({
      organizationId,
      storeId: gatedStoreId!,
      filters,
      from: u.searchParams.get("from"),
      to: u.searchParams.get("to"),
    });
  });
}
