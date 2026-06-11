import { runCenterGet } from "../_shared";
import { getCenterAutomationHealthPayload } from "@/lib/claims/center/claim-center-api-handlers";

export async function GET(req: Request) {
  return runCenterGet(req, ({ organizationId, storeId }) =>
    getCenterAutomationHealthPayload(organizationId, storeId),
  );
}
