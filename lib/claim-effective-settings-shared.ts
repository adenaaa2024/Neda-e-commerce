/** Shared claim effective-settings types (safe for client + server). */

export type ClaimGroupBySetting =
  | "manual"
  | "pallet"
  | "package"
  | "order_id"
  | "removal_order"
  | "product"
  | "issue_type"
  | "date_window";

export type CreateCaseWhenSetting =
  | "immediately"
  | "package_closed"
  | "pallet_closed"
  | "removal_order_closed"
  | "manual_only";

export type ClaimWorkflowSettings = {
  auto_grouping_enabled: boolean;
  group_by: ClaimGroupBySetting;
  create_case_when: CreateCaseWhenSetting;
  allow_mixed_products: boolean;
  allow_mixed_issue_types: boolean;
  require_product_link: boolean;
  require_operator_note: boolean;
  require_evidence: boolean;
};

export type EffectiveClaimSettingsSnapshot = {
  organization_id: string;
  store_id: string | null;
  auto_create_drafts_on_scan: boolean;
  auto_generate_pdf_reports: boolean;
  claim_from_date: string | null;
  claim_cutoff_date: string | null;
  claim_window_days: number;
  workflow: ClaimWorkflowSettings;
  allow_manual_override: boolean;
};

export const DEFAULT_CLAIM_WORKFLOW: ClaimWorkflowSettings = {
  auto_grouping_enabled: false,
  group_by: "manual",
  create_case_when: "package_closed",
  allow_mixed_products: false,
  allow_mixed_issue_types: false,
  require_product_link: true,
  require_operator_note: true,
  require_evidence: true,
};
