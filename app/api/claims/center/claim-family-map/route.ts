import { getCenterSourceCoveragePayload } from "@/lib/claims/center/claim-center-api-handlers";
import { runCenterGet } from "../_shared";

export const dynamic = "force-dynamic";

/** Slice of source-coverage focused on the claim-family → source/API map. */
export async function GET(req: Request) {
  return runCenterGet(req, async ({ organizationId }) => {
    const payload = await getCenterSourceCoveragePayload({ organizationId });
    return {
      version: payload.version,
      generated_at: payload.generated_at,
      organization_id: payload.organization_id,
      claim_family_map: payload.claim_family_map,
      totals: {
        families_total: payload.totals.families_total,
        families_complete: payload.totals.families_complete,
        families_partial: payload.totals.families_partial,
        families_preview_or_missing: payload.totals.families_preview_or_missing,
      },
    };
  });
}
