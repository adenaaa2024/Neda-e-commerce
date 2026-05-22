/**
 * NEXT-CLAIM-CANONICAL-08 — Guarded bulk mutations on claim_review_work_items (human + entitlement gated).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClaimReviewEntitlementFlags, ClaimReviewPatchBody, ClaimReviewWorkItemRow } from "./claim-review-workflow-execution";
import { executeClaimReviewWorkItemPatch, fetchClaimReviewWorkItemForOrg } from "./claim-review-workflow-execution";

export type ClaimReviewBulkAction = "bulk_assign" | "bulk_set_priority" | "bulk_quarantine" | "bulk_schedule_follow_up";

export const CLAIM_REVIEW_BULK_ACTION_LIST = [
  "bulk_assign",
  "bulk_set_priority",
  "bulk_quarantine",
  "bulk_schedule_follow_up",
] as const satisfies readonly ClaimReviewBulkAction[];

export function isClaimReviewBulkAction(v: string): v is ClaimReviewBulkAction {
  return (CLAIM_REVIEW_BULK_ACTION_LIST as readonly string[]).includes(v);
}

const MAX_IDS = 40;

export type BulkPatchPreviewRow = {
  work_item_id: string;
  would_apply: boolean;
  skip_reason: string | null;
};

export type ExecuteBulkClaimReviewPatchesResult = {
  preview: BulkPatchPreviewRow[];
  applied: number;
  skipped: number;
  errors: string[];
};

function patchActionForBulk(bulk: ClaimReviewBulkAction): ClaimReviewPatchBody["action"] {
  switch (bulk) {
    case "bulk_assign":
      return "assign";
    case "bulk_set_priority":
      return "set_priority";
    case "bulk_quarantine":
      return "quarantine";
    case "bulk_schedule_follow_up":
      return "schedule_follow_up";
    default:
      return "assign";
  }
}

function shouldSkipNoOp(args: {
  bulk: ClaimReviewBulkAction;
  row: ClaimReviewWorkItemRow;
  assignee_user_id?: string;
  priority?: string;
  quarantine_reason?: string;
}): string | null {
  const { bulk, row } = args;
  if (row.workflow_state === "completed" || row.workflow_state === "cancelled") {
    return "terminal_work_item";
  }
  switch (bulk) {
    case "bulk_assign": {
      const aid = String(args.assignee_user_id ?? "").trim();
      if (!aid) return "missing_assignee";
      if (row.assigned_to === aid && row.workflow_state === "assigned") return "already_assigned";
      return null;
    }
    case "bulk_set_priority": {
      const pr = String(args.priority ?? "").trim();
      if (!pr) return "missing_priority";
      if (row.priority === pr) return "priority_unchanged";
      return null;
    }
    case "bulk_quarantine": {
      const reason = String(args.quarantine_reason ?? "").trim();
      if (!reason) return "missing_quarantine_reason";
      if (
        row.workflow_state === "quarantined_ambiguous" &&
        row.review_queue === "quarantine_ambiguity" &&
        String(row.quarantine_reason ?? "").trim() === reason
      ) {
        return "already_quarantined_same_reason";
      }
      return null;
    }
    case "bulk_schedule_follow_up": {
      if (row.next_follow_up_at) return "follow_up_already_set";
      return null;
    }
    default:
      return null;
  }
}

/**
 * When `execute` is false, only returns preview (no DB writes).
 * When `execute` is true, applies patches row-by-row with entitlement checks per row.
 */
export async function executeBulkClaimReviewPatches(args: {
  supabase: SupabaseClient;
  organizationId: string;
  storeId: string;
  execute: boolean;
  actorUserId: string;
  ent: ClaimReviewEntitlementFlags;
  bulk: ClaimReviewBulkAction;
  workItemIds: string[];
  assignee_user_id?: string;
  priority?: string;
  quarantine_reason?: string;
  follow_up_interval_hours?: number;
}): Promise<ExecuteBulkClaimReviewPatchesResult> {
  const ids = [...new Set(args.workItemIds.map((x) => String(x).trim()).filter(Boolean))].slice(0, MAX_IDS);
  const preview: BulkPatchPreviewRow[] = [];
  const errors: string[] = [];
  let applied = 0;
  let skipped = 0;

  const singleAction = patchActionForBulk(args.bulk);
  const bodyBase: Omit<ClaimReviewPatchBody, "action"> = {
    organization_id: args.organizationId,
    store_id: args.storeId,
    assignee_user_id: args.assignee_user_id,
    priority: args.priority,
    quarantine_reason: args.quarantine_reason,
    follow_up_interval_hours: args.follow_up_interval_hours,
  };

  for (const workItemId of ids) {
    const loaded = await fetchClaimReviewWorkItemForOrg(args.supabase, {
      workItemId,
      organizationId: args.organizationId,
      storeId: args.storeId,
    });
    if (!loaded.ok) {
      preview.push({ work_item_id: workItemId, would_apply: false, skip_reason: loaded.error });
      errors.push(`${workItemId}: ${loaded.error}`);
      skipped += 1;
      continue;
    }

    const skip = shouldSkipNoOp({
      bulk: args.bulk,
      row: loaded.row,
      assignee_user_id: args.assignee_user_id,
      priority: args.priority,
      quarantine_reason: args.quarantine_reason,
    });
    if (skip) {
      preview.push({ work_item_id: workItemId, would_apply: false, skip_reason: skip });
      skipped += 1;
      continue;
    }

    preview.push({ work_item_id: workItemId, would_apply: true, skip_reason: null });

    if (!args.execute) continue;

    const body: ClaimReviewPatchBody = { ...bodyBase, action: singleAction };
    const result = await executeClaimReviewWorkItemPatch({
      supabase: args.supabase,
      row: loaded.row,
      body,
      actorUserId: args.actorUserId,
      ent: args.ent,
    });
    if (!result.ok) {
      errors.push(`${workItemId}: ${result.error}`);
      skipped += 1;
      continue;
    }
    applied += 1;
  }

  return { preview, applied, skipped, errors };
}
