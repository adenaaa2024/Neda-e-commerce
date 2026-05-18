/**
 * NEXT-CLAIM-CANONICAL-06 — Claim review work item mutations (service role + API guards).
 * No automated claim submission; human actions only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { CLAIM_CANDIDATE_DRAFTS_LIST_COLUMNS } from "./claim-drafts-api";
import {
  addHoursIso,
  CLAIM_REVIEW_WORK_ITEMS_LIST_COLUMNS,
  computeNextFollowUpIso,
  computeSlaDueAtIso,
  defaultFollowUpIntervalHours,
  type ClaimReviewPriority,
  isAllowedClaimReviewPriority,
} from "./claim-review-workflow";
import {
  OPERATOR_TRID_SELECTION_RECORDED_EVENT,
  validateOperatorTridSelectionEventPayload,
} from "./claim-trid-candidates-types";

export type ClaimReviewAuditEventType =
  | "created"
  | "assigned"
  | "unassigned"
  | "state_changed"
  | "priority_changed"
  | "sla_reset"
  | "follow_up_scheduled"
  | "quarantined"
  | "escalated"
  | "human_override"
  | "ai_suggestion_recorded"
  | typeof OPERATOR_TRID_SELECTION_RECORDED_EVENT
  | "completed"
  | "cancelled";

export async function insertClaimReviewWorkItemEvent(
  supabase: SupabaseClient,
  args: {
    workItemId: string;
    organizationId: string;
    actorUserId: string | null;
    eventType: ClaimReviewAuditEventType;
    payload: Record<string, unknown>;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from("claim_review_work_item_events").insert({
    work_item_id: args.workItemId,
    organization_id: args.organizationId,
    actor_user_id: args.actorUserId,
    event_type: args.eventType,
    payload: args.payload,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export type ClaimReviewWorkItemRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  draft_id: string;
  workflow_state: string;
  review_queue: string;
  priority: string;
  assigned_to: string | null;
  assigned_at: string | null;
  sla_due_at: string | null;
  follow_up_interval_hours: number | null;
  next_follow_up_at: string | null;
  recurring_series_id: string | null;
  escalation_level: number;
  quarantine_reason: string | null;
  ai_classification: unknown;
  ai_confidence: number | null;
  ai_model_version: string | null;
  human_override_at: string | null;
  human_override_by: string | null;
};

export async function fetchClaimReviewWorkItemForOrg(
  supabase: SupabaseClient,
  args: { workItemId: string; organizationId: string; storeId: string },
): Promise<{ ok: true; row: ClaimReviewWorkItemRow } | { ok: false; error: string; status: number }> {
  const { data, error } = await supabase
    .from("claim_review_work_items")
    .select(
      "id, organization_id, store_id, draft_id, workflow_state, review_queue, priority, " +
        "assigned_to, assigned_at, sla_due_at, follow_up_interval_hours, next_follow_up_at, " +
        "recurring_series_id, escalation_level, quarantine_reason, " +
        "ai_classification, ai_confidence, ai_model_version, human_override_at, human_override_by",
    )
    .eq("id", args.workItemId)
    .eq("organization_id", args.organizationId)
    .eq("store_id", args.storeId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!data) return { ok: false, error: "Work item not found.", status: 404 };
  return { ok: true, row: data as unknown as ClaimReviewWorkItemRow };
}

const WORK_ITEM_EVENT_COLUMNS = "id, event_type, actor_user_id, payload, created_at";

/** Read-only detail for operator drawer (work item + draft + audit timeline). */
export async function fetchClaimReviewWorkItemDetailForOrg(
  supabase: SupabaseClient,
  args: { workItemId: string; organizationId: string; storeId?: string | null },
): Promise<
  | {
      ok: true;
      work_item: Record<string, unknown>;
      draft: Record<string, unknown> | null;
      events: Record<string, unknown>[];
    }
  | { ok: false; error: string; status: number }
> {
  let workItemQuery = supabase
    .from("claim_review_work_items")
    .select(CLAIM_REVIEW_WORK_ITEMS_LIST_COLUMNS)
    .eq("id", args.workItemId)
    .eq("organization_id", args.organizationId);
  const storeId = String(args.storeId ?? "").trim();
  if (storeId) workItemQuery = workItemQuery.eq("store_id", storeId);

  const { data: wi, error: wErr } = await workItemQuery.maybeSingle();
  if (wErr) return { ok: false, error: wErr.message, status: 500 };
  if (!wi) return { ok: false, error: "Work item not found.", status: 404 };

  const workItem = wi as unknown as Record<string, unknown>;
  const draftId = String(workItem.draft_id ?? "").trim();

  let draft: Record<string, unknown> | null = null;
  if (draftId) {
    const { data: d, error: dErr } = await supabase
      .from("claim_candidate_drafts")
      .select(CLAIM_CANDIDATE_DRAFTS_LIST_COLUMNS)
      .eq("id", draftId)
      .eq("organization_id", args.organizationId)
      .maybeSingle();
    if (dErr) return { ok: false, error: dErr.message, status: 500 };
    if (d && typeof d === "object" && !Array.isArray(d)) draft = d as Record<string, unknown>;
  }

  const { data: evRows, error: eErr } = await supabase
    .from("claim_review_work_item_events")
    .select(WORK_ITEM_EVENT_COLUMNS)
    .eq("work_item_id", args.workItemId)
    .eq("organization_id", args.organizationId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (eErr) return { ok: false, error: eErr.message, status: 500 };

  const events = ((evRows ?? []) as unknown as Record<string, unknown>[]).filter(
    (r) => r != null && typeof r === "object" && !Array.isArray(r),
  );
  const actorIds = [
    ...new Set(
      events
        .map((r) => (typeof r.actor_user_id === "string" ? r.actor_user_id.trim() : ""))
        .filter(Boolean),
    ),
  ];
  if (actorIds.length > 0) {
    const { data: actors, error: actorErr } = await supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("organization_id", args.organizationId)
      .in("id", actorIds);
    if (actorErr) return { ok: false, error: actorErr.message, status: 500 };
    const byId = new Map<string, Record<string, unknown>>();
    for (const actor of (actors ?? []) as unknown as Record<string, unknown>[]) {
      const id = String(actor.id ?? "").trim();
      if (id) byId.set(id, actor);
    }
    for (const ev of events) {
      const aid = typeof ev.actor_user_id === "string" ? ev.actor_user_id : "";
      const actor = byId.get(aid);
      if (actor) {
        ev.actor = {
          id: aid,
          full_name: typeof actor.full_name === "string" ? actor.full_name : null,
          role: typeof actor.role === "string" ? actor.role : null,
        };
      }
    }
  }

  return { ok: true, work_item: workItem, draft, events };
}

/** Ensure assignee belongs to the same organization (profiles.organization_id). */
export async function assertProfileInOrganization(
  supabase: SupabaseClient,
  organizationId: string,
  profileId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", profileId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "Assignee is not a member of this organization." };
  return { ok: true };
}

export type ClaimReviewPatchAction =
  | "assign"
  | "unassign"
  | "set_priority"
  | "reset_sla"
  | "schedule_follow_up"
  | "bump_follow_up"
  | "escalate"
  | "quarantine"
  | "mark_in_review"
  | "operator_note"
  | "record_trid_selection"
  | "record_ai_placeholder"
  | "human_override"
  | "close_review";

export const CLAIM_REVIEW_PATCH_ACTION_LIST = [
  "assign",
  "unassign",
  "set_priority",
  "reset_sla",
  "schedule_follow_up",
  "bump_follow_up",
  "escalate",
  "quarantine",
  "mark_in_review",
  "operator_note",
  "record_trid_selection",
  "record_ai_placeholder",
  "human_override",
  "close_review",
] as const satisfies readonly ClaimReviewPatchAction[];

export function isClaimReviewPatchAction(v: string): v is ClaimReviewPatchAction {
  return (CLAIM_REVIEW_PATCH_ACTION_LIST as readonly string[]).includes(v);
}

export type ClaimReviewPatchBody = {
  organization_id: string;
  store_id: string;
  action: ClaimReviewPatchAction;
  assignee_user_id?: string;
  priority?: string;
  follow_up_interval_hours?: number;
  quarantine_reason?: string;
  note_text?: string;
  handoff_to_user_id?: string;
  trid_selection?: Record<string, unknown>;
  ai_classification?: Record<string, unknown>;
  ai_confidence?: number;
  ai_model_version?: string;
  /** Required when `action` is `close_review` (human confirmation). */
  confirm_close_review?: boolean;
};

export type ClaimReviewEntitlementFlags = {
  taskCreate: boolean;
  repeatFollowup: boolean;
  slaEscalation: boolean;
  aiDraft: boolean;
};

/**
 * Applies one human-gated mutation + audit row. Caller must have verified org/store + loaded `row`.
 */
export async function executeClaimReviewWorkItemPatch(args: {
  supabase: SupabaseClient;
  row: ClaimReviewWorkItemRow;
  body: ClaimReviewPatchBody;
  actorUserId: string;
  ent: ClaimReviewEntitlementFlags;
}): Promise<{ ok: true; row: ClaimReviewWorkItemRow } | { ok: false; error: string; status: number }> {
  const { supabase, row, body, actorUserId, ent } = args;
  const orgId = row.organization_id;
  const wid = row.id;

  const audit = async (type: ClaimReviewAuditEventType, payload: Record<string, unknown>) => {
    const r = await insertClaimReviewWorkItemEvent(supabase, {
      workItemId: wid,
      organizationId: orgId,
      actorUserId,
      eventType: type,
      payload,
    });
    if (!r.ok) return r;
    return { ok: true as const };
  };

  const deny = (msg: string, status: number) => ({ ok: false as const, error: msg, status });

  if (!ent.taskCreate) {
    return deny("Claims workflow task actions are not entitled for this store.", 403);
  }

  let patch: Record<string, unknown> = {};
  let auditType: ClaimReviewAuditEventType = "state_changed";
  let auditPayload: Record<string, unknown> = { action: body.action };

  switch (body.action) {
    case "assign": {
      const aid = String(body.assignee_user_id ?? "").trim();
      if (!aid) return deny("assignee_user_id is required for assign.", 400);
      const p = await assertProfileInOrganization(supabase, orgId, aid);
      if (!p.ok) return deny(p.error, 400);
      patch = {
        assigned_to: aid,
        assigned_at: new Date().toISOString(),
        workflow_state: "assigned",
        review_queue: "standard",
      };
      auditType = "assigned";
      auditPayload = { assignee_user_id: aid };
      break;
    }
    case "unassign": {
      patch = {
        assigned_to: null,
        assigned_at: null,
        workflow_state: "pending_assignment",
      };
      auditType = "unassigned";
      break;
    }
    case "set_priority": {
      const pr = String(body.priority ?? "").trim();
      if (!isAllowedClaimReviewPriority(pr)) return deny("Invalid priority.", 400);
      patch = { priority: pr };
      auditType = "priority_changed";
      auditPayload = { priority: pr };
      break;
    }
    case "reset_sla": {
      const pr = row.priority as ClaimReviewPriority;
      patch = { sla_due_at: computeSlaDueAtIso({ from: new Date(), priority: pr }) };
      auditType = "sla_reset";
      auditPayload = { sla_due_at: patch.sla_due_at };
      break;
    }
    case "schedule_follow_up": {
      if (!ent.repeatFollowup) return deny("Recurring follow-up is not entitled for this store.", 403);
      const pr = row.priority as ClaimReviewPriority;
      const hrs =
        typeof body.follow_up_interval_hours === "number" && body.follow_up_interval_hours > 0
          ? Math.floor(body.follow_up_interval_hours)
          : defaultFollowUpIntervalHours(pr);
      patch = {
        follow_up_interval_hours: hrs,
        next_follow_up_at: computeNextFollowUpIso({ from: new Date(), priority: pr }),
        review_queue: "follow_up",
      };
      auditType = "follow_up_scheduled";
      auditPayload = { follow_up_interval_hours: hrs, next_follow_up_at: patch.next_follow_up_at };
      break;
    }
    case "bump_follow_up": {
      if (!ent.repeatFollowup) return deny("Recurring follow-up is not entitled for this store.", 403);
      const pr = row.priority as ClaimReviewPriority;
      const hrs =
        typeof body.follow_up_interval_hours === "number" && body.follow_up_interval_hours > 0
          ? Math.floor(body.follow_up_interval_hours)
          : typeof row.follow_up_interval_hours === "number" && row.follow_up_interval_hours > 0
            ? row.follow_up_interval_hours
            : defaultFollowUpIntervalHours(pr);
      const next = addHoursIso(new Date(), hrs);
      patch = { next_follow_up_at: next, follow_up_interval_hours: hrs };
      auditType = "follow_up_scheduled";
      auditPayload = { bumped: true, next_follow_up_at: next, follow_up_interval_hours: hrs };
      break;
    }
    case "escalate": {
      if (!ent.slaEscalation) return deny("SLA escalation features are not entitled for this store.", 403);
      const nextLevel = Math.min(5, (row.escalation_level ?? 0) + 1);
      patch = {
        workflow_state: "escalated",
        review_queue: "escalation",
        escalation_level: nextLevel,
      };
      auditType = "escalated";
      auditPayload = { escalation_level: nextLevel };
      break;
    }
    case "quarantine": {
      const reason = String(body.quarantine_reason ?? "").trim().slice(0, 2000);
      if (!reason) return deny("quarantine_reason is required.", 400);
      patch = {
        workflow_state: "quarantined_ambiguous",
        review_queue: "quarantine_ambiguity",
        quarantine_reason: reason,
      };
      auditType = "quarantined";
      auditPayload = { quarantine_reason: reason };
      break;
    }
    case "mark_in_review": {
      patch = { workflow_state: "in_review" };
      auditType = "state_changed";
      auditPayload = { from: row.workflow_state, to: "in_review" };
      break;
    }
    case "operator_note": {
      const note = String(body.note_text ?? "").trim().slice(0, 4000);
      if (!note) return deny("note_text is required for operator_note.", 400);
      const handoffTo = String(body.handoff_to_user_id ?? "").trim();
      if (handoffTo) {
        const p = await assertProfileInOrganization(supabase, orgId, handoffTo);
        if (!p.ok) return deny(p.error, 400);
      }
      const ar = await audit("state_changed", {
        action: "operator_note",
        note_text: note,
        handoff_to_user_id: handoffTo || null,
        workflow_state: row.workflow_state,
        review_queue: row.review_queue,
      });
      if (!ar.ok) return deny(ar.error, 500);
      return { ok: true, row };
    }
    case "record_trid_selection": {
      const parsed = validateOperatorTridSelectionEventPayload(body.trid_selection, {
        workItemId: wid,
        draftId: row.draft_id,
      });
      if (!parsed.ok) return deny(parsed.error, 400);
      const ar = await audit(OPERATOR_TRID_SELECTION_RECORDED_EVENT, parsed.payload);
      if (!ar.ok) return deny(ar.error, 500);
      return { ok: true, row };
    }
    case "record_ai_placeholder": {
      if (!ent.aiDraft) return deny("AI draft features are not entitled for this store.", 403);
      const prev =
        row.ai_classification && typeof row.ai_classification === "object" && !Array.isArray(row.ai_classification)
          ? (row.ai_classification as Record<string, unknown>)
          : {};
      const incoming = body.ai_classification && typeof body.ai_classification === "object" ? body.ai_classification : {};
      patch = {
        ai_classification: { ...prev, ...incoming, _last_suggestion_at: new Date().toISOString() },
        ai_model_version: body.ai_model_version != null ? String(body.ai_model_version).slice(0, 200) : row.ai_model_version,
      };
      if (typeof body.ai_confidence === "number" && Number.isFinite(body.ai_confidence)) {
        patch.ai_confidence = Math.min(1, Math.max(0, body.ai_confidence));
      }
      auditType = "ai_suggestion_recorded";
      auditPayload = { keys: Object.keys(incoming) };
      break;
    }
    case "human_override": {
      patch = {
        human_override_at: new Date().toISOString(),
        human_override_by: actorUserId,
      };
      auditType = "human_override";
      auditPayload = {};
      break;
    }
    case "close_review": {
      if (body.confirm_close_review !== true) {
        return deny("close_review requires confirm_close_review: true in the request body.", 400);
      }
      patch = { workflow_state: "completed", review_queue: "standard" };
      auditType = "completed";
      auditPayload = { note: "Review record closed; does not submit marketplace claims." };
      break;
    }
  }

  const { data: updated, error: upErr } = await supabase
    .from("claim_review_work_items")
    .update(patch)
    .eq("id", wid)
    .eq("organization_id", orgId)
    .select(
      "id, organization_id, store_id, draft_id, workflow_state, review_queue, priority, " +
        "assigned_to, assigned_at, sla_due_at, follow_up_interval_hours, next_follow_up_at, " +
        "recurring_series_id, escalation_level, quarantine_reason, " +
        "ai_classification, ai_confidence, ai_model_version, human_override_at, human_override_by",
    )
    .single();
  if (upErr || !updated) {
    return deny(upErr?.message ?? "Update failed.", 500);
  }

  const ar = await audit(auditType, auditPayload);
  if (!ar.ok) {
    return deny(ar.error, 500);
  }

  return { ok: true, row: updated as unknown as ClaimReviewWorkItemRow };
}
