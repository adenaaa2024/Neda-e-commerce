import { NextResponse } from "next/server";

import { getCenterFilingPacketPreviewPayload } from "@/lib/claims/center/claim-center-api-handlers";
import {
  DEFAULT_CASE_REVIEW_INTAKE_RUN_ID,
  DEFAULT_PILOT_CASE_RUN_ID,
} from "@/lib/claims/pilot/claim-case-review-ui-contract";
import { runCenterGet } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!storeId) {
    return NextResponse.json(
      { error: "store_id is required for filing packet preview." },
      { status: 400 },
    );
  }

  return runCenterGet(req, async ({ organizationId, storeId: gatedStoreId, limit, url: u }) => {
    const sp = u.searchParams;
    const statusParam = sp.get("status");
    return getCenterFilingPacketPreviewPayload({
      organizationId,
      storeId: gatedStoreId!,
      query: {
        pilot_case_run_id: sp.get("pilot_case_run_id")?.trim() || DEFAULT_PILOT_CASE_RUN_ID,
        intake_run_id: sp.get("intake_run_id")?.trim() || DEFAULT_CASE_REVIEW_INTAKE_RUN_ID,
        case_id: sp.get("case_id")?.trim() || null,
        status: statusParam === null || statusParam === "" ? "open" : statusParam.trim(),
        limit: Math.min(limit, 100),
      },
    });
  });
}
