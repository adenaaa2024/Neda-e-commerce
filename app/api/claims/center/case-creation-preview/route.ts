import { NextResponse } from "next/server";

import { getCenterCaseCreationPreviewPayload } from "@/lib/claims/center/claim-center-api-handlers";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "@/lib/claims/evidence/claim-evidence-packet-v1-plan-contract";
import { runCenterGet } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!storeId) {
    return NextResponse.json({ error: "store_id is required for case creation preview." }, { status: 400 });
  }

  return runCenterGet(req, async ({ organizationId, storeId: gatedStoreId, limit, url: u }) => {
    const sp = u.searchParams;
    const candidateId = sp.get("candidate_id")?.trim() || null;
    const candidateIdsRaw = sp.get("candidate_ids")?.trim() || "";
    const candidateIds = candidateIdsRaw
      ? candidateIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const intakeRunId = sp.get("intake_run_id")?.trim() || ORIGINAL_PILOT_INTAKE_RUN_ID;
    const previewLimit = candidateId ? 1 : Math.min(limit, 50);

    return getCenterCaseCreationPreviewPayload({
      organizationId,
      storeId: gatedStoreId!,
      query: {
        intake_run_id: intakeRunId,
        limit: previewLimit,
        candidate_ids: candidateId ? [candidateId] : candidateIds,
      },
    });
  });
}
