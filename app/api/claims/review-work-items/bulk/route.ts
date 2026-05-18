import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

import { assertUserCanAccessOrganization } from "../../../../dashboard/products/pim-actions";
import { isClaimDraftsReviewEnabled } from "../../../../../lib/claim-drafts-api";
import { isClaimReviewWorkflowEnabled, resolveClaimReviewEntitlements } from "../../../../../lib/claim-review-workflow";
import {
  executeBulkClaimReviewPatches,
  isClaimReviewBulkAction,
} from "../../../../../lib/claim-review-workflow-bulk";
import { assertStoreBelongsToOrganization } from "../../../../../lib/claim-org-scope";
import { supabaseServer } from "../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../lib/uuid";

/**
 * POST /api/claims/review-work-items/bulk
 * Preview (`execute: false`) or apply (`execute: true`) guarded bulk mutations.
 * `execute: true` requires explicit human confirmation flag `confirm_execute: true`.
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
  const body = bodyRaw as Record<string, unknown>;

  const organizationId = String(body.organization_id ?? "").trim();
  const storeId = String(body.store_id ?? "").trim();
  const bulk = String(body.bulk_action ?? "").trim();
  const execute = body.execute === true;
  const confirmExecute = body.confirm_execute === true;

  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }
  if (!isUuidString(storeId)) {
    return NextResponse.json({ error: "store_id must be a UUID." }, { status: 400 });
  }
  if (!isClaimReviewBulkAction(bulk)) {
    return NextResponse.json({ error: "Invalid bulk_action." }, { status: 400 });
  }

  const rawIds = body.work_item_ids;
  const workItemIds = Array.isArray(rawIds) ? rawIds.map((x) => String(x).trim()).filter((x) => isUuidString(x)) : [];

  if (workItemIds.length === 0) {
    return NextResponse.json({ error: "work_item_ids must be a non-empty array of UUIDs." }, { status: 400 });
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

  const entSnap = resolveClaimReviewEntitlements({ organizationId, storeId });
  if (!entSnap.inboxRead.ok) {
    return NextResponse.json(
      { error: "Claims inbox is not entitled for this store.", decision: entSnap.inboxRead },
      { status: 403 },
    );
  }

  if (execute) {
    if (!confirmExecute) {
      return NextResponse.json(
        { error: "Bulk execute requires confirm_execute: true after operator review." },
        { status: 400 },
      );
    }
    if (!entSnap.taskCreate.ok) {
      return NextResponse.json(
        { error: "Bulk mutations require claims.workflow.task_create.", decision: entSnap.taskCreate },
        { status: 403 },
      );
    }
  }

  const assignee_user_id =
    typeof body.assignee_user_id === "string" && isUuidString(body.assignee_user_id.trim())
      ? body.assignee_user_id.trim()
      : undefined;
  const priority = typeof body.priority === "string" ? body.priority.trim() : undefined;
  const quarantine_reason = typeof body.quarantine_reason === "string" ? body.quarantine_reason : undefined;
  const follow_up_interval_hours =
    typeof body.follow_up_interval_hours === "number" && body.follow_up_interval_hours > 0
      ? Math.floor(body.follow_up_interval_hours)
      : undefined;

  try {
    const result = await executeBulkClaimReviewPatches({
      supabase: supabaseServer,
      organizationId,
      storeId,
      execute,
      actorUserId: gate.userId,
      ent: {
        taskCreate: entSnap.taskCreate.ok,
        repeatFollowup: entSnap.repeatFollowup.ok,
        slaEscalation: entSnap.slaEscalation.ok,
        aiDraft: entSnap.aiDraft.ok,
      },
      bulk,
      workItemIds,
      assignee_user_id,
      priority,
      quarantine_reason,
      follow_up_interval_hours,
    });

    return NextResponse.json({
      execute,
      bulk_action: bulk,
      preview: result.preview,
      applied: result.applied,
      skipped: result.skipped,
      errors: result.errors,
      entitlements: {
        inbox_read: entSnap.inboxRead.ok,
        workflow_task_create: entSnap.taskCreate.ok,
        repeat_followup: entSnap.repeatFollowup.ok,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Bulk action failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
