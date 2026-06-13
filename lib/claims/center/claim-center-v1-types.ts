import type { ProductLinkageDisplayContract } from "@/lib/product-linkage-display-contract";
import type { InboxQueue, ResolverFinalBucket } from "@/lib/claim-inbox-projection";

import type { ClaimCenterCandidateMoney } from "./claim-center-candidate-money";
import type { ClaimCenterEligibilityDisplay } from "./claim-center-eligibility-display";
import type { ClaimCenterMoneyKpis } from "./claim-center-money-contract";
import type {
  ClaimLifecycleStatus,
  ClaimPolicyWarnings,
} from "../intake/claim-intake-policy-contract";

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
  /** Read-model money projection — never coerces null to zero. */
  money_display?: ClaimCenterCandidateMoney;
  /** Policy-derived eligibility / expiry label for UI. */
  eligibility_display?: ClaimCenterEligibilityDisplay;
  /** Policy-derived lifecycle status (read-model). */
  lifecycle_status?: ClaimLifecycleStatus;
  lifecycle_status_label?: string;
  /** Read-only policy warnings for this row. */
  policy_warnings?: ClaimPolicyWarnings;
  /** Display-only twin grouping (scanner + orbit_fra per return_item). */
  twin_group_key?: string | null;
  twin_source_kinds?: string[];
  twin_candidate_ids?: string[];
  is_twin_primary?: boolean;
  /** Physical-return MVP read-model (scanner-origin slice). */
  physical_return_display?: import("./claim-center-physical-return-mvp").ClaimCenterPhysicalReturnDisplay;
};

export type ClaimCenterDashboardKpis = {
  /** @deprecated Use money.potential_recovery_known_usd — kept for smoke compat */
  recoverable_amount: number;
  ready_to_file_count: number;
  blocked_product_link_count: number;
  evidence_missing_count: number;
  expiring_soon_count: number;
  /** Rows whose status reflects an external/imported filing observation (e.g. ORBIT). */
  observed_filed_count: number;
  observed_reimbursed_count: number;
  total_active: number;
  /** Approved money contract aggregates (never sums unknowns). */
  money: ClaimCenterMoneyKpis;
  evidence_previewable_count: number;
  review_blocker_count: number;
  /** Queue counts aligned with command tiles (deduped where noted). */
  queue_counts: ClaimCenterQueueCounts;
};

export type ClaimCenterQueueCounts = {
  find_money_count: number;
  blocked_money_count: number;
  review_count: number;
  proof_count: number;
  product_unlinked_count: number;
  references_materialized_count: number;
  observed_recovery_count: number;
};

export type ClaimCenterQueryMeta = {
  items_returned: number;
  total_scanned: number;
  sample_limit: number;
  is_sample_capped: boolean;
  is_limited_scan: boolean;
  db_total_count: number | null;
};
