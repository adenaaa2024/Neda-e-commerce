/**
 * PHASE-CLAIM-GROUPING-FILTERS-AND-MANUAL-BATCH-CONTRACT-V1
 * Read-only architecture + API/UI contract for claim grouping, filtering, and manual
 * batch building BEFORE claim_cases creation. No DB writes in this phase.
 *
 * Prerequisite: PHASE-CLAIM-FIRST-SAFE-FAMILIES-PREVIEW-GENERATORS-V1 (20260613T202000Z)
 * Staging dry-run: 41 families · 1,121 claim_ready · 3,876 needs_review · delta 0
 */
import type { ClaimGroupBySetting, ClaimWorkflowSettings } from "@/lib/claim-effective-settings-shared";
import type { ManualGroupingPolicy } from "@/lib/claim-candidate-intake-policy";
import type { ClaimSourceKind } from "@/lib/claims/intake/claim-intake-types";
import type { PreviewRecommendedAction } from "@/lib/claims/center/claim-first-safe-families-preview-generators-v1";

export const GROUPING_FILTER_CONTRACT_VERSION = "claim-grouping-filters-manual-batch-v1" as const;

/** Candidate lifecycle bucket aligned with preview generators + dry-run. */
export type CandidateStatusFilter = PreviewRecommendedAction;

export type ClaimWindowStatusFilter = "open" | "closing_soon" | "expired" | "unknown";

export type MoneyPresenceFilter = "present" | "missing" | "any";

export type EvidenceStatusFilter = "complete" | "partial" | "missing" | "any";

/** TRID / reference dimensions for filter + grouping. */
export const TRID_REFERENCE_TYPES = [
  "product_link",
  "order_id",
  "removal_order_id",
  "removal_shipment_id",
  "tracking_number",
  "reimbursement_id",
  "settlement_id",
  "return_item_id",
  "package_id",
  "pallet_id",
  "expected_package_id",
  "shipment_id",
  "source_report_row",
] as const;

export type TridReferenceType = (typeof TRID_REFERENCE_TYPES)[number];

/**
 * Candidate filter contract — applies to preview items (pre-emit) and claim_candidates (post-emit).
 * All filters are AND-composed unless `filter_mode: "any_of"` on a dimension group.
 */
export type ClaimCandidateFilterContract = {
  organization_id: string;
  store_id?: string | null;
  product_id?: string | string[] | null;
  asin?: string | string[] | null;
  fnsku?: string | string[] | null;
  sku?: string | string[] | null;
  family_key?: string | string[] | null;
  claim_family?: string | string[] | null;
  source_kind?: ClaimSourceKind | ClaimSourceKind[] | null;
  status?: CandidateStatusFilter | CandidateStatusFilter[] | null;
  confidence?: ("high" | "medium" | "low" | "unavailable")[] | null;
  trid_reference_type?: TridReferenceType | TridReferenceType[] | null;
  reference_id?: string | string[] | null;
  shipment_id?: string | string[] | null;
  removal_order_id?: string | string[] | null;
  removal_shipment_id?: string | string[] | null;
  tracking_number?: string | string[] | null;
  package_id?: string | string[] | null;
  pallet_id?: string | string[] | null;
  return_item_id?: string | string[] | null;
  expected_package_id?: string | string[] | null;
  date_from?: string | null;
  date_to?: string | null;
  claim_window_status?: ClaimWindowStatusFilter | ClaimWindowStatusFilter[] | null;
  evidence_status?: EvidenceStatusFilter | null;
  observed_reimbursement?: MoneyPresenceFilter | null;
  estimated_amazon_payout?: MoneyPresenceFilter | null;
  internal_cost_loss?: MoneyPresenceFilter | null;
  review_flags_include?: string[] | null;
  review_flags_exclude?: string[] | null;
  blocker_flags_include?: string[] | null;
  blocker_flags_exclude?: string[] | null;
  source_report_table?: string | string[] | null;
  source_report_upload_id?: string | string[] | null;
  preview_ids?: string[] | null;
  candidate_ids?: string[] | null;
  duplicate_keys?: string[] | null;
  text_search?: string | null;
  limit?: number;
  offset?: number;
  sort_by?:
    | "observed_reimbursement"
    | "estimated_amazon_payout"
    | "internal_cost_loss"
    | "recovery_gap"
    | "quantity_claimed"
    | "confidence"
    | "event_date"
    | "days_remaining";
  sort_dir?: "asc" | "desc";
};

/** Deterministic grouping modes — extends legacy ClaimGroupBySetting. */
export const GROUPING_MODES = [
  "single_candidate_one_case",
  "same_product_same_family",
  "same_product_multi_family",
  "same_trid_reference",
  "same_shipment_removal_order",
  "same_source_report_window",
  "manual_selection",
  "saved_smart_filter",
  "custom_manual_with_warnings",
  "legacy_product",
  "legacy_issue_type",
  "legacy_package",
  "legacy_pallet",
  "legacy_order_id",
  "legacy_removal_order",
  "legacy_date_window",
] as const;

export type GroupingMode = (typeof GROUPING_MODES)[number];

export type GroupingModeDefinition = {
  mode: GroupingMode;
  label: string;
  description: string;
  /** Maps to existing ClaimGroupBySetting when applicable. */
  legacy_group_by?: ClaimGroupBySetting;
  auto_suggest: boolean;
  requires_saved_filter: boolean;
  allows_mixed_warning_override: boolean;
};

export const GROUPING_MODE_DEFINITIONS: readonly GroupingModeDefinition[] = [
  {
    mode: "single_candidate_one_case",
    label: "One candidate → one case",
    description: "No grouping; each selected preview/candidate becomes its own claim case.",
    auto_suggest: false,
    requires_saved_filter: false,
    allows_mixed_warning_override: true,
  },
  {
    mode: "same_product_same_family",
    label: "Same product + same problem",
    description: "Group by resolved product_id + V3 family_key (or claim_family).",
    legacy_group_by: "product",
    auto_suggest: true,
    requires_saved_filter: false,
    allows_mixed_warning_override: false,
  },
  {
    mode: "same_product_multi_family",
    label: "Same product + multiple problems",
    description: "Group by product_id only; warn on mixed claim families.",
    legacy_group_by: "product",
    auto_suggest: true,
    requires_saved_filter: false,
    allows_mixed_warning_override: true,
  },
  {
    mode: "same_trid_reference",
    label: "Same TRID / reference",
    description: "Group by primary TRID edge (removal_order_id, tracking_number, reimbursement_id, etc.).",
    auto_suggest: true,
    requires_saved_filter: false,
    allows_mixed_warning_override: true,
  },
  {
    mode: "same_shipment_removal_order",
    label: "Same shipment / removal / order",
    description: "Group by removal_order_id, removal_shipment_id, or shipment_id.",
    legacy_group_by: "removal_order",
    auto_suggest: true,
    requires_saved_filter: false,
    allows_mixed_warning_override: true,
  },
  {
    mode: "same_source_report_window",
    label: "Same source report / window",
    description: "Group by source_kind + source_report upload/window bucket.",
    legacy_group_by: "date_window",
    auto_suggest: false,
    requires_saved_filter: false,
    allows_mixed_warning_override: true,
  },
  {
    mode: "manual_selection",
    label: "Manual selection",
    description: "Operator-selected set; system evaluates warnings only.",
    legacy_group_by: "manual",
    auto_suggest: false,
    requires_saved_filter: false,
    allows_mixed_warning_override: true,
  },
  {
    mode: "saved_smart_filter",
    label: "Saved smart filter group",
    description: "Persisted filter definition re-run against current pool.",
    auto_suggest: false,
    requires_saved_filter: true,
    allows_mixed_warning_override: false,
  },
  {
    mode: "custom_manual_with_warnings",
    label: "Custom manual group",
    description: "Manual selection with explicit mixed-dimension warnings; override gated by policy + role.",
    legacy_group_by: "manual",
    auto_suggest: false,
    requires_saved_filter: false,
    allows_mixed_warning_override: true,
  },
] as const;

/** Warning codes for group builder — superset of legacy CaseBuilderWarning + V3 preview lanes. */
export const GROUP_WARNING_CODES = [
  "mixed_products",
  "mixed_claim_families",
  "mixed_source_kinds",
  "mixed_reference_types",
  "mixed_trids",
  "mixed_claim_windows",
  "missing_product_link",
  "missing_evidence",
  "missing_cost",
  "estimated_payout_unavailable",
  "observed_reimbursement_ambiguous",
  "disputed_rows_included",
  "expired_window",
  "low_confidence",
  "mixed_package",
  "mixed_pallet",
  "mixed_order",
  "policy_hold",
] as const;

export type GroupWarningCode = (typeof GROUP_WARNING_CODES)[number];

export type GroupWarningSeverity = "info" | "warn" | "block";

export type GroupWarning = {
  code: GroupWarningCode;
  message: string;
  severity: GroupWarningSeverity;
  affected_preview_ids?: string[];
};

export type GroupRecommendedAction =
  | "file_single"
  | "file_grouped"
  | "needs_review"
  | "split_group"
  | "unavailable";

/** Normalized candidate row for filter/group readmodel (preview or persisted). */
export type GroupableCandidateRow = {
  preview_id: string;
  candidate_id: string | null;
  duplicate_key: string;
  organization_id: string;
  store_id: string;
  family_key: string;
  claim_family: string;
  source_kind: ClaimSourceKind;
  source_event_key: string | null;
  product_id: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  quantity_claimed: number | null;
  quantity_confidence: "high" | "medium" | "low" | "unavailable";
  estimated_amazon_payout: number | null;
  observed_reimbursement: number | null;
  internal_cost_loss: number | null;
  reimbursement_gap: number | null;
  confidence: "high" | "medium" | "low" | "unavailable";
  recommended_action: CandidateStatusFilter;
  review_flags: string[];
  blocker_flags: string[];
  trid_edges: Array<{ reference_kind: string; reference_value: string }>;
  source_edges: Array<{ table: string; id: string }>;
  event_date: string | null;
  dispute_deadline: string | null;
  days_remaining: number | null;
  claim_window_status: ClaimWindowStatusFilter;
  evidence_status: EvidenceStatusFilter;
  reference_type: string | null;
  reference_id: string | null;
  removal_order_id: string | null;
  removal_shipment_id: string | null;
  tracking_number: string | null;
  package_id: string | null;
  pallet_id: string | null;
  return_item_id: string | null;
  expected_package_id: string | null;
  source_report_table: string | null;
  source_report_upload_id: string | null;
};

export type ClaimGroupPreviewPayload = {
  contract_version: typeof GROUPING_FILTER_CONTRACT_VERSION;
  read_only: true;
  no_db_writes: true;
  no_claim_case_creation: true;
  generated_at: string;
  organization_id: string;
  store_id: string;
  group_id: string;
  group_title: string;
  group_rule: {
    mode: GroupingMode;
    filter?: ClaimCandidateFilterContract | null;
    saved_filter_id?: string | null;
    manual_preview_ids?: string[] | null;
  };
  included_candidate_preview_ids: string[];
  included_candidate_ids: string[];
  item_count: number;
  total_units: number | null;
  estimated_amazon_payout_sum: number | null;
  observed_reimbursement_sum: number | null;
  internal_cost_loss_sum: number | null;
  recovery_gap_sum: number | null;
  confidence: "high" | "medium" | "low" | "unavailable";
  warnings: GroupWarning[];
  blocking: boolean;
  evidence_packet_preview_ready: boolean;
  recommended_action: GroupRecommendedAction;
  policy_snapshot: ClaimGroupingPolicySettings;
};

/** Settings/policy contract — persisted in organization_settings.claim_policy.grouping (JSONB, no migration). */
export type ClaimGroupingPolicySettings = {
  grouping_enabled: boolean;
  allow_mixed_product_grouping: boolean;
  allow_mixed_problem_grouping: boolean;
  allow_mixed_reference_grouping: boolean;
  require_evidence_before_grouping: boolean;
  require_cost_before_filing: boolean;
  require_product_link_before_filing: boolean;
  require_role_for_mixed_override: string | null;
  default_grouping_mode: GroupingMode;
  auto_grouping_enabled: boolean;
  /** Mirrors ClaimWorkflowSettings for backward compatibility. */
  workflow: Pick<
    ClaimWorkflowSettings,
    | "group_by"
    | "allow_mixed_products"
    | "allow_mixed_issue_types"
    | "require_product_link"
    | "require_evidence"
  >;
  /** Mirrors candidate_intake.manual_grouping. */
  manual_grouping: ManualGroupingPolicy;
};

export const DEFAULT_CLAIM_GROUPING_POLICY: ClaimGroupingPolicySettings = {
  grouping_enabled: true,
  allow_mixed_product_grouping: false,
  allow_mixed_problem_grouping: false,
  allow_mixed_reference_grouping: false,
  require_evidence_before_grouping: false,
  require_cost_before_filing: false,
  require_product_link_before_filing: true,
  require_role_for_mixed_override: "claims_operator",
  default_grouping_mode: "manual_selection",
  auto_grouping_enabled: false,
  workflow: {
    group_by: "manual",
    allow_mixed_products: false,
    allow_mixed_issue_types: false,
    require_product_link: true,
    require_evidence: true,
  },
  manual_grouping: {
    allow_single: true,
    allow_grouped: true,
    warn_mixed_products: true,
    warn_mixed_problem_types: true,
    warn_mixed_reference_types: true,
  },
};

/** Manual group builder — UI/server contract (no automatic case creation). */
export type ManualGroupBuilderContract = {
  steps: ["select_candidates", "review_warnings", "confirm_override_optional", "preview_group", "defer_case_creation"];
  selection_source: "preview_generators" | "claim_candidates_pool" | "mixed";
  max_selection_size: number;
  show_warning_panel: true;
  allow_override_when: {
    policy_allows_mixed: boolean;
    role_has_override: boolean;
    operator_confirmed: boolean;
  };
  blocked_when: {
    any_blocker_flag: string[];
    any_disputed_without_override: boolean;
    grouping_disabled: boolean;
    grouped_not_allowed_by_intake_policy: boolean;
  };
  outputs: ["group_preview_payload", "optional_evidence_packet_preview"];
  forbidden: ["auto_create_claim_case", "auto_submit", "auto_pdf", "claim_candidates_insert"];
};

/** Saved smart filter — persisted definition (JSONB phase 1; optional table phase 2). */
export type SavedSmartFilterContract = {
  saved_filter_id: string;
  organization_id: string;
  store_id: string | null;
  title: string;
  description: string | null;
  filter: ClaimCandidateFilterContract;
  default_grouping_mode: GroupingMode;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  pinned: boolean;
  /** Read-only re-run against current pool; never mutates candidates. */
  refresh_on_open: boolean;
};

export type GroupingApiEndpointsContract = {
  filter_candidates: "GET /api/claims/center/candidates/filter";
  preview_generators: "GET /api/claims/center/preview-generators";
  suggest_groups: "POST /api/claims/center/groups/suggest";
  preview_group: "POST /api/claims/center/groups/preview";
  preview_manual_group: "POST /api/claims/center/groups/manual-preview";
  list_saved_filters: "GET /api/claims/center/saved-filters";
  upsert_saved_filter: "PUT /api/claims/center/saved-filters/{id}";
  delete_saved_filter: "DELETE /api/claims/center/saved-filters/{id}";
  evidence_packet_preview: "POST /api/claims/center/evidence-packet/preview";
};

export const GROUPING_API_ENDPOINTS: GroupingApiEndpointsContract = {
  filter_candidates: "GET /api/claims/center/candidates/filter",
  preview_generators: "GET /api/claims/center/preview-generators",
  suggest_groups: "POST /api/claims/center/groups/suggest",
  preview_group: "POST /api/claims/center/groups/preview",
  preview_manual_group: "POST /api/claims/center/groups/manual-preview",
  list_saved_filters: "GET /api/claims/center/saved-filters",
  upsert_saved_filter: "PUT /api/claims/center/saved-filters/{id}",
  delete_saved_filter: "DELETE /api/claims/center/saved-filters/{id}",
  evidence_packet_preview: "POST /api/claims/center/evidence-packet/preview",
};

export type GroupingUiSectionsContract = {
  claim_center_find_money: ["family_filter_chips", "status_tabs", "money_sort", "bulk_select"];
  claim_center_review: ["needs_review_filter", "linkage_blocker_filter", "disputed_exclusion_banner"];
  group_builder_drawer: ["selection_summary", "warning_list", "split_by_dimension", "override_confirm", "preview_totals"];
  saved_filters_panel: ["pinned_filters", "create_from_current_filter", "refresh_counts"];
  group_preview_detail: ["group_title", "included_rows_table", "money_lanes_sum", "trid_edge_summary", "evidence_packet_cta"];
  settings_claim_grouping: ["grouping_toggles", "mixed_override_policy", "default_mode", "role_override_gate"];
};

export const GROUPING_UI_SECTIONS: GroupingUiSectionsContract = {
  claim_center_find_money: ["family_filter_chips", "status_tabs", "money_sort", "bulk_select"],
  claim_center_review: ["needs_review_filter", "linkage_blocker_filter", "disputed_exclusion_banner"],
  group_builder_drawer: ["selection_summary", "warning_list", "split_by_dimension", "override_confirm", "preview_totals"],
  saved_filters_panel: ["pinned_filters", "create_from_current_filter", "refresh_counts"],
  group_preview_detail: ["group_title", "included_rows_table", "money_lanes_sum", "trid_edge_summary", "evidence_packet_cta"],
  settings_claim_grouping: ["grouping_toggles", "mixed_override_policy", "default_mode", "role_override_gate"],
};

export type TablesReusePlan = {
  read_pool: {
    table: "claim_candidates";
    usage: "Post-emit pool rows; filter via indexed columns + metadata JSONB + claim_reference_edges join";
    indexes: [
      "idx_claim_candidates_org_reference",
      "idx_claim_candidates_org_event_date",
      "idx_claim_candidates_org_dispute_deadline",
      "(organization_id, store_id)",
    ];
  };
  trid_join: {
    table: "claim_reference_edges";
    usage: "TRID/reference filter and same_trid_reference grouping";
  };
  preview_source: {
    module: "buildFirstSafeFamiliesPreviewGenerators",
    usage: "Pre-emit deterministic preview rows; same filter contract mapped to PreviewGeneratorItem",
  };
  evidence_preview: {
    module: "composeClaimEvidencePacket",
    usage: "Read-only packet preview for grouped candidate_ids; confirmMixed flag",
  };
  policy_storage: {
    table: "organization_settings";
    column: "claim_policy.grouping + claim_policy.candidate_intake.manual_grouping + workflow",
    usage: "No migration — JSONB merge via existing saveOrganizationClaimPolicy path",
  };
  case_creation_deferred: {
    tables: ["claim_cases", "claim_lines"];
    usage: "NOT used in grouping readmodel phase — separate PHASE-CLAIM-CASE-BUILDER-BRIDGE",
  };
};

export type NewTablesAssessment = {
  new_tables_needed: "no_for_phase1" | "yes_optional_phase2";
  reason: string;
  optional_phase2_table: "claim_saved_filter_groups" | null;
};

export const NEW_TABLES_ASSESSMENT: NewTablesAssessment = {
  new_tables_needed: "no_for_phase1",
  reason:
    "Phase-1 grouping readmodel operates on preview generators + claim_candidates SELECT + in-memory group previews. Saved smart filters can persist in organization_settings.claim_policy.saved_filters JSONB array (tenant-scoped, auditable via organization_settings updated_at). Dedicated table only needed when cross-user pinned filters, soft-delete audit, or >100 saved filters per org.",
  optional_phase2_table: "claim_saved_filter_groups",
};

export type RlsRequirementsIfTablesNeeded = {
  required_if_table_added: boolean;
  organization_id: string;
  store_id: string | null;
  policies: ["SELECT org members", "INSERT/UPDATE org admins or claims_operator role", "soft delete via deleted_at"];
  audit: "audit_logs trigger on UPDATE/DELETE";
};

export const RLS_IF_TABLES_NEEDED: RlsRequirementsIfTablesNeeded = {
  required_if_table_added: true,
  organization_id: "NOT NULL FK organizations",
  store_id: "nullable — null means org-wide saved filter",
  policies: ["SELECT org members", "INSERT/UPDATE org admins or claims_operator role", "soft delete via deleted_at"],
  audit: "audit_logs trigger on UPDATE/DELETE",
};

/** Full contract payload for audit scripts and API bootstrap. */
export type ClaimGroupingFiltersManualBatchContractPayload = {
  contract_version: typeof GROUPING_FILTER_CONTRACT_VERSION;
  read_only: true;
  no_db_writes: true;
  no_claim_candidate_mutation: true;
  no_claim_case_creation: true;
  no_ai_calls: true;
  grouping_filter_contract: ClaimCandidateFilterContract;
  grouping_modes: typeof GROUPING_MODE_DEFINITIONS;
  warning_rules: typeof GROUP_WARNING_CODES;
  manual_group_builder_contract: ManualGroupBuilderContract;
  saved_smart_group_contract: SavedSmartFilterContract;
  group_preview_payload_shape: Omit<ClaimGroupPreviewPayload, "generated_at" | "organization_id" | "store_id" | "group_id">;
  policy_settings_needed: ClaimGroupingPolicySettings;
  api_endpoints_needed: GroupingApiEndpointsContract;
  ui_sections_needed: GroupingUiSectionsContract;
  tables_reuse_plan: TablesReusePlan;
  new_tables_needed: NewTablesAssessment;
  rls_requirements_if_tables_needed: RlsRequirementsIfTablesNeeded;
  SAFE_TO_IMPLEMENT_GROUPING_READMODEL: "yes" | "no";
  NEXT_PROMPT: string;
};

export const MANUAL_GROUP_BUILDER_CONTRACT: ManualGroupBuilderContract = {
  steps: [
    "select_candidates",
    "review_warnings",
    "confirm_override_optional",
    "preview_group",
    "defer_case_creation",
  ],
  selection_source: "mixed",
  max_selection_size: 200,
  show_warning_panel: true,
  allow_override_when: {
    policy_allows_mixed: true,
    role_has_override: true,
    operator_confirmed: true,
  },
  blocked_when: {
    any_blocker_flag: ["disputed_expected_package", "defer_until_linkage"],
    any_disputed_without_override: true,
    grouping_disabled: true,
    grouped_not_allowed_by_intake_policy: true,
  },
  outputs: ["group_preview_payload", "optional_evidence_packet_preview"],
  forbidden: ["auto_create_claim_case", "auto_submit", "auto_pdf", "claim_candidates_insert"],
};

export function buildClaimGroupingFiltersManualBatchContract(): ClaimGroupingFiltersManualBatchContractPayload {
  return {
    contract_version: GROUPING_FILTER_CONTRACT_VERSION,
    read_only: true,
    no_db_writes: true,
    no_claim_candidate_mutation: true,
    no_claim_case_creation: true,
    no_ai_calls: true,
    grouping_filter_contract: {
      organization_id: "00000000-0000-0000-0000-000000000001",
      store_id: null,
      status: "claim_ready",
      limit: 100,
      sort_by: "observed_reimbursement",
      sort_dir: "desc",
    },
    grouping_modes: GROUPING_MODE_DEFINITIONS,
    warning_rules: GROUP_WARNING_CODES,
    manual_group_builder_contract: MANUAL_GROUP_BUILDER_CONTRACT,
    saved_smart_group_contract: {
      saved_filter_id: "sf:v1:example",
      organization_id: "00000000-0000-0000-0000-000000000001",
      store_id: null,
      title: "Removal overdue — claim ready",
      description: "shipment_not_received + claim_ready + product linked",
      filter: {
        organization_id: "00000000-0000-0000-0000-000000000001",
        family_key: ["removal_shipment_missing", "removal_order_discrepancy"],
        status: "claim_ready",
        estimated_amazon_payout: "any",
      },
      default_grouping_mode: "same_product_same_family",
      created_by: null,
      created_at: "2026-06-13T00:00:00.000Z",
      updated_at: "2026-06-13T00:00:00.000Z",
      pinned: true,
      refresh_on_open: true,
    },
    group_preview_payload_shape: {
      contract_version: GROUPING_FILTER_CONTRACT_VERSION,
      read_only: true,
      no_db_writes: true,
      no_claim_case_creation: true,
      group_title: "Example group",
      group_rule: { mode: "manual_selection", manual_preview_ids: [] },
      included_candidate_preview_ids: [],
      included_candidate_ids: [],
      item_count: 0,
      total_units: null,
      estimated_amazon_payout_sum: null,
      observed_reimbursement_sum: null,
      internal_cost_loss_sum: null,
      recovery_gap_sum: null,
      confidence: "unavailable",
      warnings: [],
      blocking: false,
      evidence_packet_preview_ready: false,
      recommended_action: "needs_review",
      policy_snapshot: DEFAULT_CLAIM_GROUPING_POLICY,
    },
    policy_settings_needed: DEFAULT_CLAIM_GROUPING_POLICY,
    api_endpoints_needed: GROUPING_API_ENDPOINTS,
    ui_sections_needed: GROUPING_UI_SECTIONS,
    tables_reuse_plan: {
      read_pool: {
        table: "claim_candidates",
        usage: "Post-emit pool rows; filter via indexed columns + metadata JSONB + claim_reference_edges join",
        indexes: [
          "idx_claim_candidates_org_reference",
          "idx_claim_candidates_org_event_date",
          "idx_claim_candidates_org_dispute_deadline",
          "(organization_id, store_id)",
        ],
      },
      trid_join: {
        table: "claim_reference_edges",
        usage: "TRID/reference filter and same_trid_reference grouping",
      },
      preview_source: {
        module: "buildFirstSafeFamiliesPreviewGenerators",
        usage: "Pre-emit deterministic preview rows; same filter contract mapped to PreviewGeneratorItem",
      },
      evidence_preview: {
        module: "composeClaimEvidencePacket",
        usage: "Read-only packet preview for grouped candidate_ids; confirmMixed flag",
      },
      policy_storage: {
        table: "organization_settings",
        column: "claim_policy.grouping + claim_policy.candidate_intake.manual_grouping + workflow",
        usage: "No migration — JSONB merge via existing saveOrganizationClaimPolicy path",
      },
      case_creation_deferred: {
        tables: ["claim_cases", "claim_lines"],
        usage: "NOT used in grouping readmodel phase — separate PHASE-CLAIM-CASE-BUILDER-BRIDGE",
      },
    },
    new_tables_needed: NEW_TABLES_ASSESSMENT,
    rls_requirements_if_tables_needed: RLS_IF_TABLES_NEEDED,
    SAFE_TO_IMPLEMENT_GROUPING_READMODEL: "yes",
    NEXT_PROMPT:
      "PHASE-CLAIM-GROUPING-FILTERS-READMODEL-IMPLEMENT-V1 — implement GET filter + POST groups/preview + manual builder drawer; no case creation",
  };
}
