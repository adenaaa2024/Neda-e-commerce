import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

import { assertUserCanAccessOrganization } from "../../../dashboard/products/pim-actions";
import {
  CLAIM_CANDIDATE_DRAFTS_LIST_COLUMNS,
  isClaimDraftsReviewEnabled,
} from "../../../../lib/claim-drafts-api";
import {
  CLAIM_REVIEW_WORKFLOW_STATES,
  CLAIM_REVIEW_WORK_ITEMS_LIST_COLUMNS,
  isAllowedClaimReviewPriority,
  isAllowedClaimReviewQueue,
  isAllowedClaimReviewWorkflowState,
  isClaimReviewWorkflowEnabled,
  resolveClaimReviewEntitlements,
} from "../../../../lib/claim-review-workflow";
import { assertStoreBelongsToOrganization } from "../../../../lib/claim-org-scope";
import { supabaseServer } from "../../../../lib/supabase-server";
import { isUuidString } from "../../../../lib/uuid";

const MAX_LIMIT = 100;

function clampLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? "50", 10) || 50;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

async function countWorkItems(
  organizationId: string,
  storeId: string,
  apply: (q: ReturnType<typeof supabaseServer.from>) => ReturnType<typeof supabaseServer.from>,
): Promise<number> {
  let q = supabaseServer
    .from("claim_review_work_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("store_id", storeId);
  q = apply(q);
  const { count, error } = await q;
  if (error) return -1;
  return typeof count === "number" ? count : 0;
}

const MAX_DRAFT_IDS_FOR_SLICE = 600;

async function fetchDraftIdsForLifecycle(
  organizationId: string,
  storeId: string,
  lifecycle: string,
): Promise<string[]> {
  const { data, error } = await supabaseServer
    .from("claim_candidate_drafts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("lifecycle_status", lifecycle)
    .limit(MAX_DRAFT_IDS_FOR_SLICE);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((r) => String((r as { id?: string }).id ?? "").trim())
    .filter((id) => isUuidString(id));
}

/**
 * GET /api/claims/review-work-items
 * List + optional dashboard summary (counts). Gated: drafts + workflow flags, inbox entitlement.
 */
export async function GET(req: Request) {
  if (!isClaimDraftsReviewEnabled() || !isClaimReviewWorkflowEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!isUuidString(storeId)) {
    return NextResponse.json(
      { error: "store_id is required and must be a UUID for entitlement-scoped review listing." },
      { status: 400 },
    );
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

  const wantSummary = ["1", "true", "yes"].includes(String(url.searchParams.get("summary") ?? "").trim().toLowerCase());

  const workflowState = String(url.searchParams.get("workflow_state") ?? "").trim();
  if (workflowState && !isAllowedClaimReviewWorkflowState(workflowState)) {
    return NextResponse.json({ error: "Invalid workflow_state." }, { status: 400 });
  }

  const reviewQueue = String(url.searchParams.get("review_queue") ?? "").trim();
  if (reviewQueue && !isAllowedClaimReviewQueue(reviewQueue)) {
    return NextResponse.json({ error: "Invalid review_queue." }, { status: 400 });
  }

  const priority = String(url.searchParams.get("priority") ?? "").trim();
  if (priority && !isAllowedClaimReviewPriority(priority)) {
    return NextResponse.json({ error: "Invalid priority." }, { status: 400 });
  }

  const overdueOnly = ["1", "true", "yes"].includes(
    String(url.searchParams.get("overdue_only") ?? "").trim().toLowerCase(),
  );

  const mineOnly = ["1", "true", "yes"].includes(String(url.searchParams.get("mine") ?? "").trim().toLowerCase());

  const assignedToFilter = String(url.searchParams.get("assigned_to") ?? "").trim();
  if (assignedToFilter && !isUuidString(assignedToFilter)) {
    return NextResponse.json({ error: "assigned_to must be a UUID when provided." }, { status: 400 });
  }

  const slice = String(url.searchParams.get("dashboard_slice") ?? "").trim().toLowerCase();
  const allowedSlices = new Set([
    "",
    "overdue",
    "quarantine",
    "escalation",
    "follow_up_due",
    "unassigned",
    "draft_needs_product_link",
    "draft_needs_evidence",
  ]);
  if (slice && !allowedSlices.has(slice)) {
    return NextResponse.json({ error: "Invalid dashboard_slice." }, { status: 400 });
  }

  const limit = clampLimit(url.searchParams.get("limit"));
  const nowIso = new Date().toISOString();

  try {
    if (wantSummary) {
      const byWorkflow: Record<string, number> = {};
      for (const st of CLAIM_REVIEW_WORKFLOW_STATES) {
        const c = await countWorkItems(organizationId, storeId, (q) => q.eq("workflow_state", st));
        byWorkflow[st] = Math.max(0, c);
      }
      const overdue_open = await countWorkItems(organizationId, storeId, (q) =>
        q
          .not("sla_due_at", "is", null)
          .lt("sla_due_at", nowIso)
          .neq("workflow_state", "completed")
          .neq("workflow_state", "cancelled"),
      );
      const quarantine_open = await countWorkItems(organizationId, storeId, (q) =>
        q.eq("workflow_state", "quarantined_ambiguous"),
      );
      const escalation_open = await countWorkItems(organizationId, storeId, (q) =>
        q.eq("workflow_state", "escalated"),
      );
      const follow_up_due_open = await countWorkItems(organizationId, storeId, (q) =>
        q
          .not("next_follow_up_at", "is", null)
          .lte("next_follow_up_at", nowIso)
          .neq("workflow_state", "completed")
          .neq("workflow_state", "cancelled"),
      );
      const mine_open = await countWorkItems(organizationId, storeId, (q) =>
        q
          .eq("assigned_to", gate.userId)
          .neq("workflow_state", "completed")
          .neq("workflow_state", "cancelled"),
      );
      const unassigned_open = await countWorkItems(organizationId, storeId, (q) =>
        q
          .is("assigned_to", null)
          .neq("workflow_state", "completed")
          .neq("workflow_state", "cancelled"),
      );

      return NextResponse.json({
        summary: {
          by_workflow_state: byWorkflow,
          overdue_open: Math.max(0, overdue_open),
          quarantine_open: Math.max(0, quarantine_open),
          escalation_open: Math.max(0, escalation_open),
          follow_up_due_open: Math.max(0, follow_up_due_open),
          mine_open: Math.max(0, mine_open),
          unassigned_open: Math.max(0, unassigned_open),
        },
        entitlements: {
          inbox_read: ent.inboxRead.ok,
          workflow_task_create: ent.taskCreate.ok,
          ai_draft: ent.aiDraft.ok,
          repeat_followup: ent.repeatFollowup.ok,
          sla_escalation: ent.slaEscalation.ok,
        },
        queried_at: nowIso,
      });
    }

    let q = supabaseServer
      .from("claim_review_work_items")
      .select(CLAIM_REVIEW_WORK_ITEMS_LIST_COLUMNS)
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .order("sla_due_at", { ascending: true, nullsFirst: false })
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(limit);

    if (workflowState) q = q.eq("workflow_state", workflowState);
    if (reviewQueue) q = q.eq("review_queue", reviewQueue);
    if (priority) q = q.eq("priority", priority);
    if (assignedToFilter) q = q.eq("assigned_to", assignedToFilter);
    if (mineOnly) q = q.eq("assigned_to", gate.userId);

    let draftIdFilter: string[] | null = null;
    if (slice === "draft_needs_product_link") {
      draftIdFilter = await fetchDraftIdsForLifecycle(organizationId, storeId, "needs_product_link");
    } else if (slice === "draft_needs_evidence") {
      draftIdFilter = await fetchDraftIdsForLifecycle(organizationId, storeId, "needs_evidence");
    }

    if (draftIdFilter && draftIdFilter.length === 0) {
      return NextResponse.json({
        items: [],
        entitlements: {
          inbox_read: ent.inboxRead.ok,
          workflow_task_create: ent.taskCreate.ok,
          ai_draft: ent.aiDraft.ok,
          repeat_followup: ent.repeatFollowup.ok,
          sla_escalation: ent.slaEscalation.ok,
        },
        queried_at: nowIso,
        slice_note: "No drafts matched this lifecycle filter (within fetch cap).",
      });
    }
    if (draftIdFilter && draftIdFilter.length > 0) {
      q = q.in("draft_id", draftIdFilter);
    }

    if (slice === "overdue" || overdueOnly) {
      q = q
        .not("sla_due_at", "is", null)
        .lt("sla_due_at", nowIso)
        .neq("workflow_state", "completed")
        .neq("workflow_state", "cancelled");
    } else if (slice === "quarantine") {
      q = q.eq("workflow_state", "quarantined_ambiguous");
    } else if (slice === "escalation") {
      q = q.eq("workflow_state", "escalated");
    } else if (slice === "follow_up_due") {
      q = q
        .not("next_follow_up_at", "is", null)
        .lte("next_follow_up_at", nowIso)
        .neq("workflow_state", "completed")
        .neq("workflow_state", "cancelled");
    } else if (slice === "unassigned") {
      q = q
        .is("assigned_to", null)
        .neq("workflow_state", "completed")
        .neq("workflow_state", "cancelled");
    }

    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = (data ?? []) as Array<{ draft_id?: string }>;
    const draftIds = [...new Set(rows.map((r) => r.draft_id).filter((id): id is string => typeof id === "string"))];

    let draftById: Record<string, Record<string, unknown>> = {};
    if (draftIds.length > 0) {
      const { data: drafts, error: dErr } = await supabaseServer
        .from("claim_candidate_drafts")
        .select(CLAIM_CANDIDATE_DRAFTS_LIST_COLUMNS)
        .eq("organization_id", organizationId)
        .in("id", draftIds);
      if (dErr) {
        return NextResponse.json({ error: dErr.message }, { status: 500 });
      }
      draftById = Object.fromEntries(
        ((drafts ?? []) as Record<string, unknown>[]).map((d) => {
          const id = typeof d.id === "string" ? d.id : "";
          return [id, d] as const;
        }),
      );
    }

    const items = rows.map((row) => {
      const did = typeof row.draft_id === "string" ? row.draft_id : "";
      return { ...row, draft: did ? draftById[did] ?? null : null };
    });

    return NextResponse.json({
      items,
      entitlements: {
        inbox_read: ent.inboxRead.ok,
        workflow_task_create: ent.taskCreate.ok,
        ai_draft: ent.aiDraft.ok,
        repeat_followup: ent.repeatFollowup.ok,
        sla_escalation: ent.slaEscalation.ok,
      },
      queried_at: nowIso,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Query failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
