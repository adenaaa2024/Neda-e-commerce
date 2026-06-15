import { NextResponse } from "next/server";

import { getCenterEvidencePacketPayload } from "@/lib/claims/center/claim-center-api-handlers";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "@/lib/claims/evidence/claim-evidence-packet-v1-plan-contract";
import { runCenterGet } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!storeId) {
    return NextResponse.json({ error: "store_id is required for evidence packet preview." }, { status: 400 });
  }

  return runCenterGet(req, async ({ organizationId, storeId: gatedStoreId, limit, url: u }) => {
    const sp = u.searchParams;
    const candidateId = sp.get("candidate_id")?.trim() || null;
    const intakeRunId = sp.get("intake_run_id")?.trim() || ORIGINAL_PILOT_INTAKE_RUN_ID;
    const packetLimit = candidateId ? 1 : Math.min(limit, 50);

    return getCenterEvidencePacketPayload({
      organizationId,
      storeId: gatedStoreId!,
      query: {
        candidate_id: candidateId,
        intake_run_id: intakeRunId,
        limit: packetLimit,
      },
    });
  });
}
