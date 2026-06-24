import { getTaskCenterClaimsQueuePayload } from "@/lib/task-center/task-center-api-handlers";
import { runTaskCenterGet } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return runTaskCenterGet(req, ({ organizationId, storeId, userId, limit, url }) =>
    getTaskCenterClaimsQueuePayload({ organizationId, storeId, userId, limit, url }),
  );
}
