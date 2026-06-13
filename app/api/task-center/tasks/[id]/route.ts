import { getTaskCenterTaskDetailPayload } from "@/lib/task-center/task-center-api-handlers";
import { runTaskCenterGet } from "../../_shared";
import { isUuidString } from "@/lib/uuid";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuidString(id)) {
    return Response.json({ error: "Invalid task id." }, { status: 400 });
  }
  return runTaskCenterGet(req, ({ organizationId }) =>
    getTaskCenterTaskDetailPayload({ organizationId, taskId: id }),
  );
}
