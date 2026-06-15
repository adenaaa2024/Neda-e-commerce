import { NextResponse } from "next/server";

import { getCenterPilotReviewPayload } from "@/lib/claims/center/claim-center-api-handlers";
import { DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID } from "@/lib/claims/pilot/claim-pilot-review-readmodel";
import { runCenterGet } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!storeId) {
    return NextResponse.json({ error: "store_id is required for pilot review." }, { status: 400 });
  }

  return runCenterGet(req, async ({ organizationId, storeId: gatedStoreId, limit, url: u }) => {
    const sp = u.searchParams;
    return getCenterPilotReviewPayload({
      organizationId,
      storeId: gatedStoreId!,
      query: {
        intake_run_id: sp.get("intake_run_id")?.trim() || DEFAULT_ORIGINAL_PILOT_INTAKE_RUN_ID,
        family_key_v3: sp.get("family_key_v3")?.trim() || null,
        claim_family: sp.get("claim_family")?.trim() || null,
        source_kind: sp.get("source_kind")?.trim() || null,
        candidate_status: sp.get("candidate_status")?.trim() || null,
        evidence_status: sp.get("evidence_status")?.trim() || null,
        product_query: sp.get("product_query")?.trim() || null,
        source_event_key: sp.get("source_event_key")?.trim() || null,
        date_from: sp.get("date_from")?.trim() || null,
        date_to: sp.get("date_to")?.trim() || null,
        limit: Math.min(limit, 100),
      },
    });
  });
}
