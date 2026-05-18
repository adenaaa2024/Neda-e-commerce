import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

import { assertUserCanAccessOrganization } from "../../../../dashboard/products/pim-actions";
import { isClaimDraftsReviewEnabled } from "../../../../../lib/claim-drafts-api";
import { isClaimReviewWorkflowEnabled, resolveClaimReviewEntitlements } from "../../../../../lib/claim-review-workflow";
import { assertStoreBelongsToOrganization } from "../../../../../lib/claim-org-scope";
import { fetchReviewVerificationSnapshot } from "../../../../../lib/claim-review-workflow-verification";
import { supabaseServer } from "../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../lib/uuid";

/**
 * GET /api/claims/review-work-items/verification
 * Read-only snapshot: bootstrap plan, counts, duplicate draft_id detection, queue distribution.
 */
export async function GET(req: Request) {
  if (!isClaimDraftsReviewEnabled() || !isClaimReviewWorkflowEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();

  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }
  if (!isUuidString(storeId)) {
    return NextResponse.json({ error: "store_id must be a UUID." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    const err = gate.error;
    return NextResponse.json({ error: err }, { status: err === "Not signed in." ? 401 : 403 });
  }

  const storeOk = await assertStoreBelongsToOrganization(organizationId, storeId);
  if (!storeOk.ok) {
    return NextResponse.json({ error: storeOk.error }, { status: storeOk.status });
  }

  const ent = resolveClaimReviewEntitlements({ organizationId, storeId });
  if (!ent.inboxRead.ok) {
    return NextResponse.json(
      { error: "Claims inbox is not entitled for this store.", decision: ent.inboxRead },
      { status: 403 },
    );
  }

  try {
    const snapshot = await fetchReviewVerificationSnapshot({
      supabase: supabaseServer,
      organizationId,
      storeId,
    });
    return NextResponse.json({
      snapshot,
      entitlements: {
        inbox_read: ent.inboxRead.ok,
        workflow_task_create: ent.taskCreate.ok,
        repeat_followup: ent.repeatFollowup.ok,
        sla_escalation: ent.slaEscalation.ok,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Verification failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
