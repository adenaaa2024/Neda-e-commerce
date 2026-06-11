import { getCenterOpportunitiesPayload } from "@/lib/claims/center/claim-center-api-handlers";
import { runCenterGet } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return runCenterGet(req, async ({ organizationId, storeId, limit }) =>
    getCenterOpportunitiesPayload(organizationId, storeId, limit),
  );
}
