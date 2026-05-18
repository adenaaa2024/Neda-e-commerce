import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

import { assertUserCanAccessOrganization } from "../../../../dashboard/products/pim-actions";
import { isClaimDraftsReviewEnabled } from "../../../../../lib/claim-drafts-api";
import { bootstrapClaimReviewWorkItemsFromDrafts } from "../../../../../lib/claim-review-workflow-bootstrap";
import { isClaimReviewWorkflowEnabled, resolveClaimReviewEntitlements } from "../../../../../lib/claim-review-workflow";
import { assertStoreBelongsToOrganization } from "../../../../../lib/claim-org-scope";
import { supabaseServer } from "../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../lib/uuid";

/**
 * POST /api/claims/review-work-items/bootstrap
 * Idempotent work-item creation from `claim_candidate_drafts` (no promotion, no claim submit).
 * Body: { organization_id, store_id, dry_run?: boolean, confirm_execute?: boolean }
 */
export async function POST(req: Request) {
  if (!isClaimDraftsReviewEnabled() || !isClaimReviewWorkflowEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let bodyRaw: unknown;
  try {
    bodyRaw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!bodyRaw || typeof bodyRaw !== "object" || Array.isArray(bodyRaw)) {
    return NextResponse.json({ error: "Body must be an object." }, { status: 400 });
  }
  const body = bodyRaw as unknown as Record<string, unknown>;

  const organizationId = String(body.organization_id ?? "").trim();
  const storeId = String(body.store_id ?? "").trim();
  const dryRun = ["1", "true", "yes"].includes(String(body.dry_run ?? "").trim().toLowerCase());
  const confirmExecute = body.confirm_execute === true;

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
    const err = storeOk.error;
    const st = storeOk.status;
    return NextResponse.json({ error: err }, { status: st });
  }

  const entSnap = resolveClaimReviewEntitlements({ organizationId, storeId });
  if (!entSnap.inboxRead.ok) {
    return NextResponse.json(
      { error: "Claims inbox is not entitled for this store.", decision: entSnap.inboxRead },
      { status: 403 },
    );
  }
  if (!dryRun && !entSnap.taskCreate.ok) {
    return NextResponse.json(
      { error: "Bootstrap execution requires claims.workflow.task_create.", decision: entSnap.taskCreate },
      { status: 403 },
    );
  }
  if (!dryRun && !confirmExecute) {
    return NextResponse.json(
      { error: "Bootstrap execute requires confirm_execute: true after operator review." },
      { status: 400 },
    );
  }

  try {
    const result = await bootstrapClaimReviewWorkItemsFromDrafts({
      supabase: supabaseServer,
      organizationId,
      storeId,
      dryRun,
      actorUserId: gate.userId,
    });

    return NextResponse.json({
      dry_run: dryRun,
      plan: result.plan,
      inserted_count: result.inserted_count,
      events_inserted: result.events_inserted,
      errors: result.errors,
      entitlements: {
        inbox_read: entSnap.inboxRead.ok,
        workflow_task_create: entSnap.taskCreate.ok,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Bootstrap failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
