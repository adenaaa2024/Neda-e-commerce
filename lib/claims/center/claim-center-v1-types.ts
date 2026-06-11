import type { ProductLinkageDisplayContract } from "@/lib/product-linkage-display-contract";
import type { InboxQueue, ResolverFinalBucket } from "@/lib/claim-inbox-projection";

export type ClaimCenterV1StatusGroup =
  | "new"
  | "needs_review"
  | "evidence_ready"
  | "blocked_product_link"
  | "blocked_reference_conflict"
  | "ready_to_file"
  | "filed"
  | "reimbursed"
  | "rejected"
  | "expired";

export type ClaimCenterWindowStatus = "open" | "closing_soon" | "expired" | "unknown";

export type ClaimCenterCanonicalWindow = {
  status: ClaimCenterWindowStatus;
  days_remaining: number | null;
  deadline: string | null;
};

export type ClaimCenterV1Badge = {
  kind:
    | "source"
    | "product"
    | "trid"
    | "evidence"
    | "deadline"
    | "conflict"
    | "automation"
    | "external";
  label: string;
  tone: "neutral" | "success" | "warning" | "danger" | "info";
};

export type ClaimCenterV1Row = {
  id: string;
  organization_id: string;
  store_id: string | null;
  source_kind: string | null;
  source_table: string;
  source_row_id: string;
  claim_family: string | null;
  claim_reason: string | null;
  event_date: string | null;
  reference_id: string | null;
  reference_type: string | null;
  recovery_value: number | null;
  cogs_unit: number | null;
  currency: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
  candidate_status: string | null;
  evidence_status: string | null;
  quarantined_at: string | null;
  intake_run_id: string | null;
  v1_status_group: ClaimCenterV1StatusGroup;
  v1_status_label: string;
  inbox_queue: InboxQueue;
  final_bucket: ResolverFinalBucket;
  automation_allowed: boolean;
  reason_codes: string[];
  badges: ClaimCenterV1Badge[];
  canonical_window: ClaimCenterCanonicalWindow;
  source_observed_window: ClaimCenterCanonicalWindow | null;
  orbit_evidence_summary: string | null;
  orbit_external_case_status: string | null;
  orbit_case_group: string | null;
  amazon_reference_id: string | null;
  reference_edge_count: number;
  ambiguity_pending: boolean;
  product_linkage: ProductLinkageDisplayContract | null;
  product_unresolved_reason: string | null;
  product_story_href: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type ClaimCenterDashboardKpis = {
  recoverable_amount: number;
  ready_for_review_count: number;
  blocked_product_link_count: number;
  evidence_missing_count: number;
  expiring_soon_count: number;
  filed_count: number;
  reimbursed_count: number;
  total_active: number;
};
