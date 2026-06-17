import { NextResponse } from "next/server";

import { CenterApiError, centerModuleGateOrThrow } from "@/lib/claims/center/claim-center-api-handlers";
import { gateOrgStoreFromUrl } from "@/lib/claims/center/claim-center-api-shared";
import { attemptGuardedManualFilingExecuteV1 } from "@/lib/claims/submission/claim-manual-filing-status-entry-guarded-execute-v1";
import {
  DEFAULT_INTAKE_RUN_ID,
  DEFAULT_PILOT_CASE_RUN_ID,
} from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

type Body = {
  claim_submission_id?: string;
  amazon_case_id?: string;
  filed_at?: string;
  amazon_case_url?: string;
  filing_notes?: string;
  attestation?: boolean;
  pilot_case_run_id?: string;
  intake_run_id?: string;
  execute_run_id?: string;
};

export async function POST(req: Request) {
  const url = new URL(req.url);
  const gate = await gateOrgStoreFromUrl(url);
  if (!gate.ok) return gate.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const claimSubmissionId = str(body.claim_submission_id);
  if (!claimSubmissionId) {
    return NextResponse.json({ error: "claim_submission_id is required." }, { status: 400 });
  }

  try {
    await centerModuleGateOrThrow(gate.organizationId);
    const result = await attemptGuardedManualFilingExecuteV1(
      supabaseServer,
      gate.organizationId,
      gate.storeId!,
      {
        claim_submission_id: claimSubmissionId,
        amazon_case_id: str(body.amazon_case_id),
        filed_at: str(body.filed_at),
        amazon_case_url: str(body.amazon_case_url),
        filing_notes: str(body.filing_notes),
        attestation: body.attestation === true,
        pilot_case_run_id: str(body.pilot_case_run_id) || DEFAULT_PILOT_CASE_RUN_ID,
        intake_run_id: str(body.intake_run_id) || DEFAULT_INTAKE_RUN_ID,
        execute_run_id: str(body.execute_run_id) || undefined,
      },
      gate.userId,
    );

    if (result.blocked) {
      return NextResponse.json(result, { status: 403 });
    }
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (e) {
    if (e instanceof CenterApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    const msg = e instanceof Error ? e.message : "Execute failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}
