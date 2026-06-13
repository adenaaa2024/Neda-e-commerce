/**
 * Product Amazon lifecycle quantity read-model contract types.
 * PHASE-PRODUCT-AMAZON-LIFECYCLE-QUANTITY-READMODEL-CONTRACT-V1
 */

export const LIFECYCLE_STATE_KEYS = [
  "sent_to_amazon",
  "received_by_amazon",
  "available_fba",
  "reserved_fba",
  "warehouse_internal",
  "sold",
  "refunded_or_canceled",
  "customer_returned",
  "removed_created",
  "removed_shipped",
  "disposed",
  "damaged",
  "lost",
  "expired",
  "stranded",
  "reimbursed",
  "unreimbursed_gap",
  "fee_or_dimension_issue",
] as const;

export type LifecycleStateKey = (typeof LIFECYCLE_STATE_KEYS)[number];

export type LifecycleSourceType = "api" | "file" | "scanner" | "resolver" | "computed";

export type LifecycleConfidence = "high" | "medium" | "low" | "unavailable" | "disputed";

export type LifecycleFreshness = "fresh" | "stale" | "missing" | "unknown";

export type LifecycleStateCounter = {
  state_key: LifecycleStateKey;
  label: string;
  quantity: number | null;
  quantity_display: string;
  amount: number | null;
  amount_display: string | null;
  as_of: string | null;
  source_table: string | null;
  source_type: LifecycleSourceType;
  confidence: LifecycleConfidence;
  freshness: LifecycleFreshness;
  claim_candidate_capable: "yes" | "no" | "partial";
  blocker_reason: string | null;
  disputed_quantity: number | null;
  excluded_from_primary_reason: string | null;
};

export const LIFECYCLE_STATE_LABELS: Record<LifecycleStateKey, string> = {
  sent_to_amazon: "Sent to Amazon",
  received_by_amazon: "Received by Amazon",
  available_fba: "Available at Amazon (FBA)",
  reserved_fba: "Reserved FBA",
  warehouse_internal: "Warehouse / internal stock",
  sold: "Sold",
  refunded_or_canceled: "Canceled / refunded",
  customer_returned: "Customer returned (FBA)",
  removed_created: "Removal created",
  removed_shipped: "Removal shipped",
  disposed: "Disposed",
  damaged: "Damaged",
  lost: "Lost",
  expired: "Expired",
  stranded: "Stranded",
  reimbursed: "Reimbursed (observed)",
  unreimbursed_gap: "Unreimbursed gap",
  fee_or_dimension_issue: "Fee / dimension issue",
};

export const DISPUTED_EP_BUILD_STATUSES = [
  "shipment_overflow_conflict",
  "detail_remainder",
  "source_conflict",
  "stale_partial_snapshot",
  "duplicate_source_conflict",
] as const;
