import { NextResponse } from "next/server";

import {
  CenterApiError,
  getCenterTridResolverPayload,
} from "@/lib/claims/center/claim-center-api-handlers";
import { gateOrgStoreFromUrl } from "@/lib/claims/center/claim-center-api-shared";
import {
  DEFAULT_INTAKE_RUN_ID,
  DEFAULT_PILOT_CASE_RUN_ID,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const gate = await gateOrgStoreFromUrl(url);
  if (!gate.ok) return gate.response;
  if (!gate.storeId) {
    return NextResponse.json({ error: "store_id is required." }, { status: 400 });
  }

  const sp = url.searchParams;
  try {
    const payload = await getCenterTridResolverPayload({
      organizationId: gate.organizationId,
      storeId: gate.storeId,
      claim_submission_id: sp.get("claim_submission_id")?.trim() || undefined,
      claim_case_id: sp.get("claim_case_id")?.trim() || undefined,
      pilot_case_run_id: sp.get("pilot_case_run_id")?.trim() || DEFAULT_PILOT_CASE_RUN_ID,
      intake_run_id: sp.get("intake_run_id")?.trim() || DEFAULT_INTAKE_RUN_ID,
    });
    return NextResponse.json(payload);
  } catch (e) {
    if (e instanceof CenterApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : "TRID resolver failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
