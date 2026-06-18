import { NextResponse } from "next/server";

import {
  CenterApiError,
  getCenterReimbursementMatchRefreshPreviewPayload,
} from "@/lib/claims/center/claim-center-api-handlers";
import { gateOrgStoreFromUrl } from "@/lib/claims/center/claim-center-api-shared";
import {
  DEFAULT_INTAKE_RUN_ID,
  DEFAULT_PILOT_CASE_RUN_ID,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";

export const dynamic = "force-dynamic";

type Body = {
  claim_submission_id?: string;
  pilot_case_run_id?: string;
  intake_run_id?: string;
};

export async function POST(req: Request) {
  const url = new URL(req.url);
  const gate = await gateOrgStoreFromUrl(url);
  if (!gate.ok) return gate.response;
  if (!gate.storeId) {
    return NextResponse.json({ error: "store_id is required." }, { status: 400 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const claimSubmissionId = String(body.claim_submission_id ?? "").trim();
  if (!claimSubmissionId) {
    return NextResponse.json({ error: "claim_submission_id is required." }, { status: 400 });
  }

  try {
    const payload = await getCenterReimbursementMatchRefreshPreviewPayload({
      organizationId: gate.organizationId,
      storeId: gate.storeId,
      claim_submission_id: claimSubmissionId,
      pilot_case_run_id: String(body.pilot_case_run_id ?? "").trim() || DEFAULT_PILOT_CASE_RUN_ID,
      intake_run_id: String(body.intake_run_id ?? "").trim() || DEFAULT_INTAKE_RUN_ID,
    });
    return NextResponse.json(payload);
  } catch (e) {
    if (e instanceof CenterApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : "Reimbursement match preview failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
