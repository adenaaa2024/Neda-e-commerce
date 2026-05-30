/** Claim cutoff & hold policy v1 — stored in organization_settings.claim_policy JSONB. */

export type ClaimGroupingPolicy =
  | "single_item"
  | "group_by_package"
  | "group_by_order"
  | "group_by_pallet";

export type ClaimHoldPolicyFlag =
  | "hold_until_package_closed"
  | "hold_until_pallet_closed"
  | "hold_until_order_complete"
  | "manual_review_required";

export type ClaimEligibilityClaimSource =
  | "scanner_operator_issue"
  | "ready_for_claim"
  | "import_candidate"
  | "expected_mismatch";

export type ClaimPolicyV1 = {
  schema_version: 1;
  scan_go_live_date: string | null;
  claim_start_date: string | null;
  claim_eligibility_window_days: number;
  claim_grouping_policy: ClaimGroupingPolicy;
  claim_hold_policy: ClaimHoldPolicyFlag[];
  allow_manual_override?: boolean;
};

export type ClaimEligibilityReason =
  | "allowed"
  | "scan_not_live"
  | "import_pre_cutoff"
  | "outside_window"
  | "hold_package_open"
  | "hold_pallet_open"
  | "hold_order_incomplete"
  | "manual_review_required"
  | "missing_scanner_evidence"
  | "promote_disabled";

export type ClaimEligibilityResult = {
  allowed: boolean;
  reason: ClaimEligibilityReason;
  effective_policy: ClaimPolicyV1;
  event_at: string | null;
  cutoff_date: string | null;
};

export const DEFAULT_CLAIM_POLICY_V1: ClaimPolicyV1 = {
  schema_version: 1,
  scan_go_live_date: null,
  claim_start_date: null,
  claim_eligibility_window_days: 90,
  claim_grouping_policy: "single_item",
  claim_hold_policy: ["hold_until_package_closed"],
};

export const CLAIM_GROUPING_POLICY_OPTIONS: { value: ClaimGroupingPolicy; label: string }[] = [
  { value: "single_item", label: "Single item (one claim line per return item)" },
  { value: "group_by_package", label: "Group by package" },
  { value: "group_by_order", label: "Group by order" },
  { value: "group_by_pallet", label: "Group by pallet" },
];
