/**
 * CLAIM-INBOX-AUDIT-12 — claim_candidate_drafts read API helpers (narrow select, flags).
 */

export const CLAIM_CANDIDATE_DRAFTS_LIST_COLUMNS =
  "id, organization_id, store_id, source_table, source_row_id, " +
  "claim_family, claim_reason, evidence_status, lifecycle_status, " +
  "confidence_score, sku, asin, fnsku, product_id, resolved_product_id, " +
  "blocker_reasons, recommended_action, created_at, updated_at";

/** Lifecycle values allowed by DB CHECK on claim_candidate_drafts. */
export const CLAIM_DRAFT_LIFECYCLE_STATUSES = [
  "draft",
  "blocked",
  "needs_evidence",
  "needs_product_link",
  "ready_for_review",
  "approved_for_candidate",
  "rejected",
  "promoted_to_claim_candidates",
  "archived",
] as const;

export type ClaimDraftLifecycleStatus = (typeof CLAIM_DRAFT_LIFECYCLE_STATUSES)[number];

const LIFECYCLE_SET = new Set<string>(CLAIM_DRAFT_LIFECYCLE_STATUSES);

/** Known V2 source tables from staging load; extend when new generators ship. */
export const CLAIM_DRAFT_SOURCE_TABLES = [
  "amazon_returns",
  "amazon_removals",
  "amazon_removal_shipments",
] as const;

const SOURCE_SET = new Set<string>(CLAIM_DRAFT_SOURCE_TABLES);

export function isClaimDraftsReviewEnabled(): boolean {
  const raw = process.env.ENABLE_CLAIM_DRAFTS_REVIEW?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}

export function isAllowedDraftLifecycleStatus(value: string): value is ClaimDraftLifecycleStatus {
  return LIFECYCLE_SET.has(value);
}

export function isAllowedDraftSourceTable(value: string): boolean {
  return SOURCE_SET.has(value);
}
