/**
 * NEXT-CLAIM-CANONICAL-07 — Idempotent bootstrap of claim_review_work_items from claim_candidate_drafts.
 * No claim_candidates mutation, no draft promotion, no marketplace submit.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClaimReviewPriority, ClaimReviewQueue, ClaimReviewWorkflowState } from "./claim-review-workflow";
import { insertClaimReviewWorkItemEvent } from "./claim-review-workflow-execution";

/** Drafts eligible for a review work item (not terminal / not post-promotion). */
export const BOOTSTRAP_ELIGIBLE_DRAFT_LIFECYCLES = [
  "draft",
  "blocked",
  "needs_evidence",
  "needs_product_link",
  "ready_for_review",
] as const;

export type BootstrapEligibleLifecycle = (typeof BOOTSTRAP_ELIGIBLE_DRAFT_LIFECYCLES)[number];

const ELIGIBLE_SET = new Set<string>(BOOTSTRAP_ELIGIBLE_DRAFT_LIFECYCLES);

export type DraftBootstrapSource = {
  id: string;
  organization_id: string;
  store_id: string | null;
  source_table: string;
  lifecycle_status: string;
  blocker_reasons: unknown;
  evidence_status: string;
};

export type WorkItemInsertFromDraft = {
  organization_id: string;
  store_id: string | null;
  target_kind: "claim_candidate_draft";
  draft_id: string;
  workflow_state: ClaimReviewWorkflowState;
  review_queue: ClaimReviewQueue;
  priority: ClaimReviewPriority;
  quarantine_reason: string | null;
};

function firstBlockerSnippet(blocker_reasons: unknown): string | null {
  if (blocker_reasons == null) return null;
  if (Array.isArray(blocker_reasons)) {
    for (const x of blocker_reasons) {
      if (typeof x === "string" && x.trim()) return x.trim().slice(0, 500);
      if (x && typeof x === "object" && "reason" in (x as object)) {
        const r = (x as { reason?: unknown }).reason;
        if (typeof r === "string" && r.trim()) return r.trim().slice(0, 500);
      }
    }
    return null;
  }
  if (typeof blocker_reasons === "object") {
    try {
      return JSON.stringify(blocker_reasons).slice(0, 2000);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Maps draft lifecycle to review queue / state (DB CHECK–compatible).
 * - needs_product_link → priority queue (product linkage triage; no separate DB enum).
 * - needs_evidence → follow_up queue (evidence cycle).
 * - blocked → quarantined_ambiguous + quarantine_ambiguity.
 */
export function mapDraftLifecycleToWorkItemFields(
  lifecycle: string,
  blocker_reasons: unknown,
): Pick<WorkItemInsertFromDraft, "workflow_state" | "review_queue" | "priority" | "quarantine_reason"> {
  switch (lifecycle) {
    case "blocked":
      return {
        workflow_state: "quarantined_ambiguous",
        review_queue: "quarantine_ambiguity",
        priority: "p0",
        quarantine_reason:
          firstBlockerSnippet(blocker_reasons) ?? "lifecycle:blocked",
      };
    case "needs_evidence":
      return {
        workflow_state: "pending_assignment",
        review_queue: "follow_up",
        priority: "p2",
        quarantine_reason: null,
      };
    case "needs_product_link":
      return {
        workflow_state: "pending_assignment",
        review_queue: "priority",
        priority: "p1",
        quarantine_reason: null,
      };
    case "ready_for_review":
      return {
        workflow_state: "pending_assignment",
        review_queue: "standard",
        priority: "p1",
        quarantine_reason: null,
      };
    case "draft":
    default:
      return {
        workflow_state: "pending_assignment",
        review_queue: "standard",
        priority: "p2",
        quarantine_reason: null,
      };
  }
}

export function draftRowToWorkItemInsert(row: DraftBootstrapSource): WorkItemInsertFromDraft | null {
  if (!ELIGIBLE_SET.has(row.lifecycle_status)) return null;
  const mapped = mapDraftLifecycleToWorkItemFields(row.lifecycle_status, row.blocker_reasons);
  return {
    organization_id: row.organization_id,
    store_id: row.store_id,
    target_kind: "claim_candidate_draft",
    draft_id: row.id,
    ...mapped,
  };
}

export type BootstrapPlanBucket = {
  lifecycle_status: string;
  count: number;
};

export type BootstrapPlan = {
  organization_id: string;
  store_id: string | null;
  eligible_draft_count: number;
  /** Eligible drafts that already have a `claim_review_work_items` row. */
  existing_work_item_draft_count: number;
  missing_draft_count: number;
  by_lifecycle: BootstrapPlanBucket[];
  by_source_table: { source_table: string; count: number }[];
  by_store: { store_id: string | null; count: number }[];
  sample_missing_draft_ids: string[];
};

export type BootstrapExecuteResult = {
  plan: BootstrapPlan;
  inserted_count: number;
  events_inserted: number;
  errors: string[];
};

async function fetchEligibleDrafts(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string | null | undefined,
): Promise<DraftBootstrapSource[]> {
  let q = supabase
    .from("claim_candidate_drafts")
    .select("id, organization_id, store_id, source_table, lifecycle_status, blocker_reasons, evidence_status")
    .eq("organization_id", organizationId)
    .in("lifecycle_status", [...BOOTSTRAP_ELIGIBLE_DRAFT_LIFECYCLES]);
  if (storeId) q = q.eq("store_id", storeId);
  const { data, error } = await q;
  if (error) throw new Error(`claim_candidate_drafts: ${error.message}`);
  return (data ?? []) as unknown as DraftBootstrapSource[];
}

async function fetchExistingWorkItemDraftIds(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string | null | undefined,
): Promise<Set<string>> {
  let q = supabase.from("claim_review_work_items").select("draft_id").eq("organization_id", organizationId);
  if (storeId) q = q.eq("store_id", storeId);
  const { data, error } = await q;
  if (error) throw new Error(`claim_review_work_items: ${error.message}`);
  const set = new Set<string>();
  for (const r of data ?? []) {
    const id = (r as { draft_id?: string }).draft_id;
    if (typeof id === "string") set.add(id);
  }
  return set;
}

function buildPlan(
  organizationId: string,
  storeId: string | null | undefined,
  drafts: DraftBootstrapSource[],
  existingDraftIds: Set<string>,
): BootstrapPlan {
  const missing = drafts.filter((d) => !existingDraftIds.has(d.id));
  const alreadyHave = drafts.length - missing.length;
  const byLife = new Map<string, number>();
  const bySource = new Map<string, number>();
  const byStore = new Map<string | null, number>();
  for (const d of missing) {
    byLife.set(d.lifecycle_status, (byLife.get(d.lifecycle_status) ?? 0) + 1);
    bySource.set(d.source_table, (bySource.get(d.source_table) ?? 0) + 1);
    byStore.set(d.store_id ?? null, (byStore.get(d.store_id ?? null) ?? 0) + 1);
  }
  return {
    organization_id: organizationId,
    store_id: storeId ?? null,
    eligible_draft_count: drafts.length,
    existing_work_item_draft_count: alreadyHave,
    missing_draft_count: missing.length,
    by_lifecycle: Array.from(byLife.entries()).map(([lifecycle_status, count]) => ({ lifecycle_status, count })),
    by_source_table: Array.from(bySource.entries()).map(([source_table, count]) => ({ source_table, count })),
    by_store: Array.from(byStore.entries()).map(([sid, count]) => ({ store_id: sid, count })),
    sample_missing_draft_ids: missing.slice(0, 20).map((d) => d.id),
  };
}

/**
 * Plans and optionally executes bootstrap. Idempotent: only inserts rows for drafts without a work item.
 */
export async function bootstrapClaimReviewWorkItemsFromDrafts(args: {
  supabase: SupabaseClient;
  organizationId: string;
  storeId?: string | null;
  dryRun: boolean;
  /** Actor for `created` events (null for system/script). */
  actorUserId: string | null;
}): Promise<BootstrapExecuteResult> {
  const drafts = await fetchEligibleDrafts(args.supabase, args.organizationId, args.storeId);
  const existingIds = await fetchExistingWorkItemDraftIds(args.supabase, args.organizationId, args.storeId);
  const plan = buildPlan(args.organizationId, args.storeId ?? null, drafts, existingIds);

  if (args.dryRun || plan.missing_draft_count === 0) {
    return { plan, inserted_count: 0, events_inserted: 0, errors: [] };
  }

  const missingRows = drafts.filter((d) => !existingIds.has(d.id));
  const inserts: WorkItemInsertFromDraft[] = [];
  for (const d of missingRows) {
    const ins = draftRowToWorkItemInsert(d);
    if (ins) inserts.push(ins);
  }

  let inserted = 0;
  let events = 0;
  const errors: string[] = [];

  /** One row per call: idempotent via UNIQUE(draft_id); concurrent runs may race — duplicate key is ignored. */
  for (const one of inserts) {
    const { data: row, error: e2 } = await args.supabase
      .from("claim_review_work_items")
      .insert(one as unknown as Record<string, unknown>)
      .select("id, draft_id, organization_id")
      .maybeSingle();
    if (e2) {
      const code = (e2 as { code?: string }).code;
      const msg = String(e2.message ?? "");
      if (code === "23505" || msg.toLowerCase().includes("duplicate")) continue;
      errors.push(`draft ${one.draft_id}: ${e2.message}`);
      continue;
    }
    if (!row) continue;
    inserted += 1;
    const r = row as { id: string; organization_id: string };
    const ev = await insertClaimReviewWorkItemEvent(args.supabase, {
      workItemId: r.id,
      organizationId: r.organization_id,
      actorUserId: args.actorUserId,
      eventType: "created",
      payload: { draft_id: one.draft_id, bootstrap: true, work_item_semantic: "work_item_created" },
    });
    if (ev.ok) events += 1;
    else errors.push(`event ${r.id}: ${"error" in ev ? ev.error : "unknown"}`);
  }

  return { plan, inserted_count: inserted, events_inserted: events, errors };
}
