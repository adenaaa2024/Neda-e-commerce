/**
 * NEXT-CLAIM-CANONICAL-05 — Claim review workflow model (constants + SLA helpers).
 * No automated claim submission; human review remains authoritative.
 */

import { assertEntitlement, type EntitlementDecision } from "./entitlements/resolve-entitlement";

export const CLAIM_REVIEW_WORKFLOW_STATES = [
  "pending_assignment",
  "assigned",
  "in_review",
  "escalated",
  "quarantined_ambiguous",
  "completed",
  "cancelled",
] as const;

export type ClaimReviewWorkflowState = (typeof CLAIM_REVIEW_WORKFLOW_STATES)[number];

/** Persisted `claim_review_work_items.review_queue` — routing / dashboard tabs. */
export const CLAIM_REVIEW_QUEUES = [
  "standard",
  "priority",
  "quarantine_ambiguity",
  "escalation",
  "follow_up",
] as const;

export type ClaimReviewQueue = (typeof CLAIM_REVIEW_QUEUES)[number];

export const CLAIM_REVIEW_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type ClaimReviewPriority = (typeof CLAIM_REVIEW_PRIORITIES)[number];

const WORKFLOW_STATE_SET = new Set<string>(CLAIM_REVIEW_WORKFLOW_STATES);
const REVIEW_QUEUE_SET = new Set<string>(CLAIM_REVIEW_QUEUES);
const PRIORITY_SET = new Set<string>(CLAIM_REVIEW_PRIORITIES);

export function isAllowedClaimReviewWorkflowState(v: string): v is ClaimReviewWorkflowState {
  return WORKFLOW_STATE_SET.has(v);
}

export function isAllowedClaimReviewQueue(v: string): v is ClaimReviewQueue {
  return REVIEW_QUEUE_SET.has(v);
}

export function isAllowedClaimReviewPriority(v: string): v is ClaimReviewPriority {
  return PRIORITY_SET.has(v);
}

/** Default SLA horizon from assignment / (re)open (hours). */
export function defaultSlaHoursForPriority(priority: ClaimReviewPriority): number {
  switch (priority) {
    case "p0":
      return 4;
    case "p1":
      return 24;
    case "p2":
      return 72;
    case "p3":
      return 168;
    default:
      return 72;
  }
}

/** Default follow-up spacing when recurring reviews are enabled (hours). */
export function defaultFollowUpIntervalHours(priority: ClaimReviewPriority): number {
  switch (priority) {
    case "p0":
      return 4;
    case "p1":
      return 12;
    case "p2":
      return 48;
    case "p3":
      return 120;
    default:
      return 48;
  }
}

export function addHoursIso(base: Date, hours: number): string {
  const ms = base.getTime() + hours * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

export function computeSlaDueAtIso(args: {
  readonly from: Date;
  readonly priority: ClaimReviewPriority;
}): string {
  return addHoursIso(args.from, defaultSlaHoursForPriority(args.priority));
}

export function computeNextFollowUpIso(args: {
  readonly from: Date;
  readonly priority: ClaimReviewPriority;
}): string {
  return addHoursIso(args.from, defaultFollowUpIntervalHours(args.priority));
}

/** Master gate for review workflow surfaces (drafts flag must also be on for drafts-backed UI). */
export function isClaimReviewWorkflowEnabled(): boolean {
  const raw = process.env.ENABLE_CLAIM_REVIEW_WORKFLOW?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}

export type ClaimReviewReadinessSnapshot = {
  readonly inboxRead: EntitlementDecision;
  readonly taskCreate: EntitlementDecision;
  readonly aiDraft: EntitlementDecision;
  readonly repeatFollowup: EntitlementDecision;
  readonly slaEscalation: EntitlementDecision;
};

/**
 * Entitlement snapshot for routing (static catalog resolver).
 * Callers pass `storeId` when known — inbox read requires store per catalog.
 */
export function resolveClaimReviewEntitlements(args: {
  readonly organizationId: string;
  readonly storeId: string | null;
  readonly staticDenyList?: readonly string[];
}): ClaimReviewReadinessSnapshot {
  const scope = { organizationId: args.organizationId, storeId: args.storeId };
  const opts = args.staticDenyList ? { staticDenyList: args.staticDenyList } : undefined;
  return {
    inboxRead: assertEntitlement("claims.inbox.read", scope, opts),
    taskCreate: assertEntitlement("claims.workflow.task_create", scope, opts),
    aiDraft: assertEntitlement("claims.ai.draft", scope, opts),
    repeatFollowup: assertEntitlement("claims.repeat_followup", scope, opts),
    slaEscalation: assertEntitlement("claims.sla_escalation", scope, opts),
  };
}

export const CLAIM_REVIEW_WORK_ITEMS_LIST_COLUMNS =
  "id, organization_id, store_id, target_kind, draft_id, workflow_state, review_queue, priority, " +
  "assigned_to, assigned_at, sla_due_at, follow_up_interval_hours, next_follow_up_at, " +
  "recurring_series_id, escalation_level, quarantine_reason, " +
  "ai_classification, ai_confidence, ai_model_version, human_override_at, human_override_by, " +
  "billing_meter_refs, created_at, updated_at";
