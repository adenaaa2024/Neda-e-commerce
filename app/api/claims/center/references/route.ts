import { getCenterReferencesPayload } from "@/lib/claims/center/claim-center-api-handlers";
import { runCenterGet } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return runCenterGet(req, async ({ organizationId, storeId, limit, url }) => {
    const candidateId = String(url.searchParams.get("candidate_id") ?? "").trim() || null;
    return getCenterReferencesPayload(organizationId, storeId, candidateId, limit);
  });
}
