import { NextResponse } from "next/server";

import { getCenterCaseReviewPayload } from "@/lib/claims/center/claim-center-api-handlers";
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
    return NextResponse.json({ error: "store_id is required for case review." }, { status: 400 });
  }

  return runCenterGet(req, async ({ organizationId, storeId: gatedStoreId, limit, url: u }) => {
    const sp = u.searchParams;
    return getCenterCaseReviewPayload({
      organizationId,
      storeId: gatedStoreId!,
      query: {
        pilot_case_run_id: sp.get("pilot_case_run_id")?.trim() || DEFAULT_PILOT_CASE_RUN_ID,
        intake_run_id: sp.get("intake_run_id")?.trim() || DEFAULT_CASE_REVIEW_INTAKE_RUN_ID,
        family_key_v3: sp.get("family_key_v3")?.trim() || null,
        claim_family: sp.get("claim_family")?.trim() || null,
        source_event_key: sp.get("source_event_key")?.trim() || null,
        status: sp.get("status")?.trim() || null,
        product_query: sp.get("product_query")?.trim() || null,
        date_from: sp.get("date_from")?.trim() || null,
        date_to: sp.get("date_to")?.trim() || null,
        limit: Math.min(limit, 100),
      },
    });
  });
}
