import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

import { assertUserCanAccessOrganization } from "../../../../dashboard/products/pim-actions";
import { isClaimDraftsReviewEnabled } from "../../../../../lib/claim-drafts-api";
import {
  isClaimReviewWorkflowEnabled,
  resolveClaimReviewEntitlements,
} from "../../../../../lib/claim-review-workflow";
import {
  executeClaimReviewWorkItemPatch,
  fetchClaimReviewWorkItemDetailForOrg,
  fetchClaimReviewWorkItemForOrg,
  isClaimReviewPatchAction,
  type ClaimReviewPatchBody,
} from "../../../../../lib/claim-review-workflow-execution";
import { assertStoreBelongsToOrganization } from "../../../../../lib/claim-org-scope";
import { supabaseServer } from "../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../lib/uuid";

type RouteCtx = { params: Promise<{ workItemId: string }> };

/**
 * GET /api/claims/review-work-items/:workItemId?organization_id=&store_id=
 * Read-only detail: work item, linked draft, audit event timeline.
 * `store_id` is optional for deep links; when omitted, the work item store is derived after org scoping.
 */
export async function GET(req: Request, ctx: RouteCtx) {
  if (!isClaimDraftsReviewEnabled() || !isClaimReviewWorkflowEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const { workItemId } = await ctx.params;
  if (!isUuidString(workItemId)) {
    return NextResponse.json({ error: "workItemId must be a UUID." }, { status: 400 });
  }

  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeIdRaw = String(url.searchParams.get("store_id") ?? "").trim();

  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }
  if (storeIdRaw && !isUuidString(storeIdRaw)) {
    return NextResponse.json({ error: "store_id must be a UUID." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const detail = await fetchClaimReviewWorkItemDetailForOrg(supabaseServer, {
    workItemId,
    organizationId,
    storeId: storeIdRaw || null,
  });
  if (!detail.ok) {
    return NextResponse.json({ error: detail.error }, { status: detail.status });
  }

  const resolvedStoreId = String(detail.work_item.store_id ?? "").trim();
  if (!isUuidString(resolvedStoreId)) {
    return NextResponse.json({ error: "Work item has no valid store_id." }, { status: 400 });
  }

  const storeOk = await assertStoreBelongsToOrganization(organizationId, resolvedStoreId);
  if (!storeOk.ok) {
    return NextResponse.json({ error: storeOk.error }, { status: storeOk.status });
  }

  const entSnap = resolveClaimReviewEntitlements({ organizationId, storeId: resolvedStoreId });
  if (!entSnap.inboxRead.ok) {
    return NextResponse.json(
      { error: "Claims inbox is not entitled for this store.", decision: entSnap.inboxRead },
      { status: 403 },
    );
  }

  return NextResponse.json({
    work_item: detail.work_item,
    draft: detail.draft,
    events: detail.events,
    entitlements: {
      inbox_read: entSnap.inboxRead.ok,
      workflow_task_create: entSnap.taskCreate.ok,
      ai_draft: entSnap.aiDraft.ok,
      repeat_followup: entSnap.repeatFollowup.ok,
      sla_escalation: entSnap.slaEscalation.ok,
    },
  });
}

/**
 * PATCH /api/claims/review-work-items/:workItemId
 * Human-gated assignment / SLA / follow-up / escalation / quarantine / AI placeholder / close review.
 */
export async function PATCH(req: Request, ctx: RouteCtx) {
  if (!isClaimDraftsReviewEnabled() || !isClaimReviewWorkflowEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const { workItemId } = await ctx.params;
  if (!isUuidString(workItemId)) {
    return NextResponse.json({ error: "workItemId must be a UUID." }, { status: 400 });
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
  const action = String(body.action ?? "").trim();

  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }
  if (!isUuidString(storeId)) {
    return NextResponse.json({ error: "store_id must be a UUID." }, { status: 400 });
  }
  if (!isClaimReviewPatchAction(action)) {
    return NextResponse.json({ error: "Invalid action." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
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

  const patchBody: ClaimReviewPatchBody = {
    organization_id: organizationId,
    store_id: storeId,
    action,
    assignee_user_id: typeof body.assignee_user_id === "string" ? body.assignee_user_id : undefined,
    priority: typeof body.priority === "string" ? body.priority : undefined,
    follow_up_interval_hours:
      typeof body.follow_up_interval_hours === "number" ? body.follow_up_interval_hours : undefined,
    quarantine_reason: typeof body.quarantine_reason === "string" ? body.quarantine_reason : undefined,
    note_text: typeof body.note_text === "string" ? body.note_text : undefined,
    handoff_to_user_id: typeof body.handoff_to_user_id === "string" ? body.handoff_to_user_id : undefined,
    trid_selection:
      body.trid_selection && typeof body.trid_selection === "object" && !Array.isArray(body.trid_selection)
        ? (body.trid_selection as Record<string, unknown>)
        : undefined,
    ai_classification:
      body.ai_classification && typeof body.ai_classification === "object" && !Array.isArray(body.ai_classification)
        ? (body.ai_classification as Record<string, unknown>)
        : undefined,
    ai_confidence: typeof body.ai_confidence === "number" ? body.ai_confidence : undefined,
    ai_model_version: typeof body.ai_model_version === "string" ? body.ai_model_version : undefined,
    confirm_close_review: body.confirm_close_review === true,
  };

  const loaded = await fetchClaimReviewWorkItemForOrg(supabaseServer, {
    workItemId,
    organizationId,
    storeId,
  });
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  }

  const result = await executeClaimReviewWorkItemPatch({
    supabase: supabaseServer,
    row: loaded.row,
    body: patchBody,
    actorUserId: gate.userId,
    ent: {
      taskCreate: entSnap.taskCreate.ok,
      repeatFollowup: entSnap.repeatFollowup.ok,
      slaEscalation: entSnap.slaEscalation.ok,
      aiDraft: entSnap.aiDraft.ok,
    },
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    work_item: result.row,
    entitlements: {
      inbox_read: entSnap.inboxRead.ok,
      workflow_task_create: entSnap.taskCreate.ok,
      ai_draft: entSnap.aiDraft.ok,
      repeat_followup: entSnap.repeatFollowup.ok,
      sla_escalation: entSnap.slaEscalation.ok,
    },
  });
}
