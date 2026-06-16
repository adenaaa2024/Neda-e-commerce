import { NextResponse } from "next/server";

import { getCenterReimbursementTrackingPayload } from "@/lib/claims/center/claim-center-api-handlers";
import {
  DEFAULT_INTAKE_RUN_ID,
  DEFAULT_PILOT_CASE_RUN_ID,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import { runCenterGet } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!storeId) {
    return NextResponse.json(
      { error: "store_id is required for reimbursement tracking." },
      { status: 400 },
    );
  }

  return runCenterGet(req, async ({ organizationId, storeId: gatedStoreId, url: u }) => {
    const sp = u.searchParams;
    return getCenterReimbursementTrackingPayload({
      organizationId,
      storeId: gatedStoreId!,
      pilot_case_run_id: sp.get("pilot_case_run_id")?.trim() || DEFAULT_PILOT_CASE_RUN_ID,
      intake_run_id: sp.get("intake_run_id")?.trim() || DEFAULT_INTAKE_RUN_ID,
    });
  });
}
