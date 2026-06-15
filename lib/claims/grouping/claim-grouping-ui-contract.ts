/**
 * PHASE-CLAIM-GROUPING-FILTERS-UI-V1
 * Read-only UI contract for Claim Group Builder — maps to grouping-preview API.
 */
import {
  GROUPING_MODES_SUPPORTED,
  type GroupingModeSupported,
} from "@/lib/claims/grouping/claim-grouping-readmodel";
import type { GroupRecommendedAction } from "@/lib/claims/contracts/claim-grouping-filters-manual-batch-contract-v1";
import type { PreviewRecommendedAction } from "@/lib/claims/center/claim-first-safe-families-preview-generators-v1";
import type { ClaimSourceKind } from "@/lib/claims/intake/claim-intake-types";

export const CLAIM_GROUP_BUILDER_UI_VERSION = "claim-grouping-filters-ui-v1" as const;

export type ClaimGroupBuilderFilterState = {
  product_id: string;
  asin: string;
  fnsku: string;
  sku: string;
  family_key: string;
  source_kind: string;
  status: PreviewRecommendedAction | "";
  confidence: string;
  reference_kind: string;
  reference_value: string;
  shipment_id: string;
  removal_order_id: string;
  removal_shipment_id: string;
  tracking_number: string;
  date_from: string;
  date_to: string;
  min_estimated_payout: string;
  min_observed_reimbursement: string;
  include_needs_review: boolean;
  include_unavailable: boolean;
};

export const DEFAULT_GROUP_BUILDER_FILTER_STATE: ClaimGroupBuilderFilterState = {
  product_id: "",
  asin: "",
  fnsku: "",
  sku: "",
  family_key: "",
  source_kind: "",
  status: "",
  confidence: "",
  reference_kind: "",
  reference_value: "",
  shipment_id: "",
  removal_order_id: "",
  removal_shipment_id: "",
  tracking_number: "",
  date_from: "",
  date_to: "",
  min_estimated_payout: "",
  min_observed_reimbursement: "",
  include_needs_review: false,
  include_unavailable: false,
};

export const GROUPING_MODE_UI_LABELS: Record<GroupingModeSupported, { label: string; description: string }> = {
  one_candidate_per_group: {
    label: "One candidate per group",
    description: "Each preview row becomes its own group — no merging.",
  },
  product_family: {
    label: "Product + family",
    description: "Group by product and claim family.",
  },
  product_multi_family: {
    label: "Product (multi-family)",
    description: "Group all families for the same product together.",
  },
  reference_trid: {
    label: "Reference / TRID",
    description: "Group by primary Amazon reference anchor.",
  },
  shipment_or_removal: {
    label: "Shipment / removal",
    description: "Group by removal order, shipment, or tracking.",
  },
  source_report_window: {
    label: "Source report window",
    description: "Group by source kind and report table.",
  },
  manual_selection_preview: {
    label: "Manual selection",
    description: "Preview a group from explicitly selected rows.",
  },
  custom_filter_preview: {
    label: "Custom filter batch",
    description: "Single batch for the active filter set.",
  },
};

export const STATUS_FILTER_OPTIONS: Array<{ value: PreviewRecommendedAction | ""; label: string }> = [
  { value: "", label: "Claim-ready default" },
  { value: "claim_ready", label: "Claim ready" },
  { value: "needs_review", label: "Needs review" },
  { value: "unavailable", label: "Unavailable" },
];

export const CONFIDENCE_FILTER_OPTIONS = [
  { value: "", label: "Any confidence" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "unavailable", label: "Unavailable" },
] as const;

export const SOURCE_KIND_FILTER_OPTIONS: Array<{ value: ClaimSourceKind | ""; label: string }> = [
  { value: "", label: "Any source" },
  { value: "delayed_not_received", label: "Delayed not received" },
  { value: "amazon_removal_api", label: "Amazon removal API" },
  { value: "reimbursement", label: "Reimbursement" },
  { value: "scanner_physical_review", label: "Physical return scan" },
  { value: "shipment_discrepancy", label: "Shipment discrepancy" },
];

export const FAMILY_FILTER_OPTIONS = [
  { value: "", label: "Any family" },
  { value: "removal_shipment_missing", label: "Removal shipment missing" },
  { value: "removal_order_discrepancy", label: "Removal order discrepancy" },
  { value: "partial_incorrect_reimbursement", label: "Partial incorrect reimbursement" },
  { value: "physical_return_scanner_issue", label: "Physical return scanner issue" },
] as const;

export const REFERENCE_KIND_OPTIONS = [
  { value: "", label: "Any reference" },
  { value: "removal_order", label: "Removal order" },
  { value: "removal_shipment", label: "Removal shipment" },
  { value: "tracking", label: "Tracking" },
  { value: "shipment", label: "Shipment" },
  { value: "reimbursement", label: "Reimbursement" },
] as const;

export const GROUPING_MODES_UI = GROUPING_MODES_SUPPORTED;

export const RECOMMENDED_ACTION_LABELS: Record<GroupRecommendedAction, string> = {
  file_single: "File single",
  file_grouped: "File grouped",
  needs_review: "Needs review",
  split_group: "Split group",
  unavailable: "Unavailable",
};

/** Disabled write placeholders — labels only; buttons stay disabled in UI V1. */
export const CLAIM_GROUP_BUILDER_DISABLED_ACTIONS = [
  { id: "create_case", label: "Create case" },
  { id: "emit_candidates", label: "Emit candidates" },
  { id: "build_evidence_packet", label: "Build evidence packet" },
] as const;

export function filterStateToApiParams(
  filters: ClaimGroupBuilderFilterState,
  groupingMode: GroupingModeSupported,
  extra?: { preview_ids?: string[]; limit?: number },
): Record<string, string> {
  const params: Record<string, string> = {
    grouping_mode: groupingMode,
    limit: String(extra?.limit ?? 50),
  };

  const set = (key: keyof ClaimGroupBuilderFilterState, apiKey?: string) => {
    const v = filters[key];
    if (typeof v === "boolean") {
      if (v) params[apiKey ?? key] = "true";
      return;
    }
    const s = String(v ?? "").trim();
    if (s) params[apiKey ?? key] = s;
  };

  set("product_id");
  set("asin");
  set("fnsku");
  set("sku");
  set("family_key");
  set("source_kind");
  set("status");
  set("confidence");
  set("reference_kind");
  set("reference_value");
  set("shipment_id");
  set("removal_order_id");
  set("removal_shipment_id");
  set("tracking_number");
  set("date_from");
  set("date_to");
  set("min_estimated_payout");
  set("min_observed_reimbursement");
  set("include_needs_review");
  set("include_unavailable");

  if (extra?.preview_ids?.length) {
    params.preview_ids = extra.preview_ids.join(",");
  }

  return params;
}

export function activeFilterChipCount(filters: ClaimGroupBuilderFilterState): number {
  let n = 0;
  for (const [k, v] of Object.entries(filters)) {
    if (k === "include_needs_review" || k === "include_unavailable") {
      if (v) n += 1;
      continue;
    }
    if (String(v).trim()) n += 1;
  }
  return n;
}
