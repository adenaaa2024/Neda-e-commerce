/**
 * NEXT-CLAIM-CANONICAL-08 — Read-only verification snapshot for review operations (no mutations).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { bootstrapClaimReviewWorkItemsFromDrafts } from "./claim-review-workflow-bootstrap";

export type ReviewQueueCount = { review_queue: string; count: number };

export type DraftLifecycleCount = { lifecycle_status: string; count: number };

export type ReviewVerificationSnapshot = {
  organization_id: string;
  store_id: string;
  queried_at: string;
  bootstrap_plan: Awaited<ReturnType<typeof bootstrapClaimReviewWorkItemsFromDrafts>>["plan"];
  work_items_total: number;
  duplicate_draft_ids: string[];
  /** All events for org (events table is not store-scoped). */
  events_total_org: number;
  queue_distribution: ReviewQueueCount[];
  drafts_by_lifecycle: DraftLifecycleCount[];
};

const DRAFT_LIFECYCLES_FOR_DASHBOARD = [
  "needs_product_link",
  "needs_evidence",
  "draft",
  "blocked",
  "ready_for_review",
] as const;

export async function fetchReviewVerificationSnapshot(args: {
  supabase: SupabaseClient;
  organizationId: string;
  storeId: string;
}): Promise<ReviewVerificationSnapshot> {
  const { supabase, organizationId, storeId } = args;
  const queriedAt = new Date().toISOString();

  const dry = await bootstrapClaimReviewWorkItemsFromDrafts({
    supabase,
    organizationId,
    storeId,
    dryRun: true,
    actorUserId: null,
  });

  const { count: wiTotal, error: wiErr } = await supabase
    .from("claim_review_work_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("store_id", storeId);
  if (wiErr) throw new Error(wiErr.message);

  const { data: wiRows, error: wiSelErr } = await supabase
    .from("claim_review_work_items")
    .select("draft_id, review_queue")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId);
  if (wiSelErr) throw new Error(wiSelErr.message);

  const draftSeen = new Map<string, number>();
  const byQueue = new Map<string, number>();
  for (const r of wiRows ?? []) {
    const row = r as { draft_id?: string; review_queue?: string };
    if (typeof row.draft_id === "string") {
      draftSeen.set(row.draft_id, (draftSeen.get(row.draft_id) ?? 0) + 1);
    }
    const q = typeof row.review_queue === "string" ? row.review_queue : "unknown";
    byQueue.set(q, (byQueue.get(q) ?? 0) + 1);
  }
  const duplicate_draft_ids = [...draftSeen.entries()].filter(([, n]) => n > 1).map(([id]) => id);

  const { count: evCount, error: evErr } = await supabase
    .from("claim_review_work_item_events")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (evErr) throw new Error(evErr.message);

  const draftsByLife: DraftLifecycleCount[] = [];
  for (const life of DRAFT_LIFECYCLES_FOR_DASHBOARD) {
    const { count, error } = await supabase
      .from("claim_candidate_drafts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .eq("lifecycle_status", life);
    if (error) throw new Error(error.message);
    draftsByLife.push({ lifecycle_status: life, count: typeof count === "number" ? count : 0 });
  }

  const queue_distribution: ReviewQueueCount[] = Array.from(byQueue.entries())
    .map(([review_queue, count]) => ({ review_queue, count }))
    .sort((a, b) => b.count - a.count);

  return {
    organization_id: organizationId,
    store_id: storeId,
    queried_at: queriedAt,
    bootstrap_plan: dry.plan,
    work_items_total: typeof wiTotal === "number" ? wiTotal : 0,
    duplicate_draft_ids,
    events_total_org: typeof evCount === "number" ? evCount : 0,
    queue_distribution,
    drafts_by_lifecycle: draftsByLife,
  };
}
