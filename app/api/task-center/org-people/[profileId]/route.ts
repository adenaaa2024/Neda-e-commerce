import { getTaskCenterOrgPeopleDetailPayload } from "@/lib/task-center/task-center-api-handlers";
import { isUuidString } from "@/lib/uuid";
import { runTaskCenterGet } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ profileId: string }> }) {
  const { profileId } = await ctx.params;
  if (!isUuidString(profileId)) {
    return Response.json({ error: "Invalid profile id." }, { status: 400 });
  }
  return runTaskCenterGet(req, ({ organizationId }) =>
    getTaskCenterOrgPeopleDetailPayload({ organizationId, profileId }),
  );
}
