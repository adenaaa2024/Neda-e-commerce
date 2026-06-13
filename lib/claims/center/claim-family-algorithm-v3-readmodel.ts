/**
 * Claim family algorithm matrix V3 read-model — contract + AI optional overlay, no DB writes.
 * PHASE-CLAIM-FAMILY-V3-READMODEL-AND-AI-OPTIONAL-CONTRACT-V1
 */
import {
  AI_DISABLED_BEHAVIOR,
  AI_ENABLED_BEHAVIOR,
  AI_FEATURE_FLAG_SOURCES,
  AI_NOT_REQUIRED_GUARDS,
  AI_OPTIONAL_CAPABILITY_MATRIX,
  type AiNotRequiredGuard,
  type AiOptionalCapability,
} from "@/lib/claims/contracts/claim-family-ai-optional-contract-v1";
import {
  CLAIM_ALGORITHM_HARD_RULES,
} from "@/lib/claims/contracts/claim-family-algorithm-matrix-v1";
import {
  CLAIM_FAMILY_MATRIX_V3,
  FEE_ADJUSTED_PAYOUT_RULE_BY_FAMILY_V3,
  FIRST_SAFE_5_FAMILIES_V3,
  IMPLEMENTATION_PRIORITY_V3,
  MISSING_SOURCE_MAPPING,
  OFFICIAL_REPORT_TYPE_MAPPING,
  REMOVED_OR_MERGED_FAMILIES,
  V3_CLASSIFICATION_COUNTS,
  V3_CLAIM_CAPABLE_COUNT,
  V3_CLAIM_FAMILY_COUNT,
  type ClaimFamilyMatrixV3Entry,
  type V3FamilyClassification,
} from "@/lib/claims/contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";
import type { MenorixAiModuleAccess } from "@/lib/menorix/evaluate-menorix-ai-module-access";

export type V3ApiClassification =
  | "claim_family"
  | "claim_when_source_available"
  | "review_signal_only"
  | "lifecycle_only";

export type ClaimFamilyAlgorithmV3ApiEntry = {
  family_key: string;
  family_label: string;
  classification: V3ApiClassification;
  source_tables: string[];
  report_api_source: string[];
  quantity_formula: string;
  money_formula: {
    fee_amount: string;
    estimated_payout: string;
    observed_reimbursement: string;
    internal_cost_loss: string;
  };
  fee_adjusted_payout_rule: string;
  observed_reimbursement_rule: string;
  trid_requirements: string[];
  product_linkage_requirement: ClaimFamilyMatrixV3Entry["product_linkage_requirement"];
  confidence_rules: ClaimFamilyMatrixV3Entry["source_confidence"];
  create_candidate_vs_review_signal_rules: {
    create_candidate: string;
    review_signal_only: string;
    exclude: string;
  };
  missing_blockers: string | null;
  implementation_priority: ClaimFamilyMatrixV3Entry["implementation_priority"];
  current_availability: ClaimFamilyMatrixV3Entry["current_availability"];
  required_identifiers: string[];
  registry_sync_kinds: string[];
};

export type ClaimFamilyAlgorithmV3Payload = {
  read_only: true;
  no_db_writes: true;
  no_generator_implementation: true;
  no_claim_submission: true;
  generated_at: string;
  version: "v3";
  family_count: number;
  classification_counts: {
    claim_capable: number;
    claim_family: number;
    claim_when_source_available: number;
    review_signal_only: number;
    lifecycle_only: number;
  };
  hard_rules: readonly string[];
  implementation_priority: readonly string[];
  first_safe_5_families: readonly string[];
  removed_or_merged_families: typeof REMOVED_OR_MERGED_FAMILIES;
  official_report_type_mapping: typeof OFFICIAL_REPORT_TYPE_MAPPING;
  missing_source_mapping: typeof MISSING_SOURCE_MAPPING;
  ai_optional: {
    capability_matrix: typeof AI_OPTIONAL_CAPABILITY_MATRIX;
    not_required_guards: typeof AI_NOT_REQUIRED_GUARDS;
    feature_flags_checked: {
      sources: readonly string[];
      ai_module_access: MenorixAiModuleAccess | null;
      ai_required_for_core_readmodel: false;
      ai_effectively_ready: boolean;
      behavior_when_ai_disabled: typeof AI_DISABLED_BEHAVIOR;
      behavior_when_ai_enabled: typeof AI_ENABLED_BEHAVIOR;
    };
  };
  families: ClaimFamilyAlgorithmV3ApiEntry[];
};

function mapClassification(c: V3FamilyClassification): V3ApiClassification {
  if (c === "claim_family_when_source_available") return "claim_when_source_available";
  if (c === "lifecycle_grouping_only") return "lifecycle_only";
  return c;
}

function candidateRules(
  entry: ClaimFamilyMatrixV3Entry,
  apiClass: V3ApiClassification,
): ClaimFamilyAlgorithmV3ApiEntry["create_candidate_vs_review_signal_rules"] {
  if (apiClass === "review_signal_only") {
    return {
      create_candidate: "EXCLUDE — review signal family; never auto-claim without promotion policy",
      review_signal_only: "ALWAYS — display signal; operator may promote after evidence",
      exclude: "Auto money candidate creation blocked",
    };
  }
  if (apiClass === "lifecycle_only") {
    return {
      create_candidate: "EXCLUDE — lifecycle/workflow only",
      review_signal_only: "MAY display dashboard chips",
      exclude: "No claim candidate from lifecycle grouping alone",
    };
  }
  if (apiClass === "claim_when_source_available") {
    return {
      create_candidate: "When required report/API source populated + linkage resolved + not disputed",
      review_signal_only: `When source unavailable (${entry.current_availability}) or blocker: ${entry.blocked_reason ?? "unknown"}`,
      exclude: "Empty connector treated as unavailable NULL — not zero",
    };
  }
  return {
    create_candidate: "When generator live + linkage resolved + clean row + policy window open",
    review_signal_only: "When partial source, disputed row, or missing COGS/fee spine",
    exclude: entry.blocked_reason ? `Blocked: ${entry.blocked_reason}` : "legacy_seed, quarantined, quantity zero",
  };
}

function mapEntry(entry: ClaimFamilyMatrixV3Entry): ClaimFamilyAlgorithmV3ApiEntry {
  const classification = mapClassification(entry.classification);
  return {
    family_key: entry.family_key,
    family_label: entry.display_name,
    classification,
    source_tables: [...entry.normalized_tables],
    report_api_source: [...entry.required_reports_api],
    quantity_formula: entry.quantity_formula,
    money_formula: {
      fee_amount: entry.fee_amount_formula,
      estimated_payout: entry.estimated_amazon_payout_formula,
      observed_reimbursement: entry.observed_reimbursement_formula,
      internal_cost_loss: entry.internal_cost_loss_formula,
    },
    fee_adjusted_payout_rule: FEE_ADJUSTED_PAYOUT_RULE_BY_FAMILY_V3[entry.family_key] ?? "NULL",
    observed_reimbursement_rule: entry.observed_reimbursement_formula,
    trid_requirements: [...entry.trid_edges_required],
    product_linkage_requirement: entry.product_linkage_requirement,
    confidence_rules: { ...entry.source_confidence },
    create_candidate_vs_review_signal_rules: candidateRules(entry, classification),
    missing_blockers: entry.blocked_reason,
    implementation_priority: entry.implementation_priority,
    current_availability: entry.current_availability,
    required_identifiers: [...entry.required_identifiers],
    registry_sync_kinds: [...entry.registry_sync_kinds],
  };
}

function countClassifications(): ClaimFamilyAlgorithmV3Payload["classification_counts"] {
  return {
    claim_capable: V3_CLAIM_CAPABLE_COUNT,
    claim_family: V3_CLASSIFICATION_COUNTS.claim_family,
    claim_when_source_available: V3_CLASSIFICATION_COUNTS.claim_when_source_available,
    review_signal_only: V3_CLASSIFICATION_COUNTS.review_signal_only,
    lifecycle_only: V3_CLASSIFICATION_COUNTS.lifecycle_only,
  };
}

/** Build V3 algorithm matrix payload (no DB writes). */
export function buildClaimFamilyAlgorithmV3Payload(options?: {
  ai_module_access?: MenorixAiModuleAccess | null;
}): ClaimFamilyAlgorithmV3Payload {
  const aiAccess = options?.ai_module_access ?? null;
  const aiReady = aiAccess?.state === "ready";

  const families = CLAIM_FAMILY_MATRIX_V3.map(mapEntry).sort((a, b) => {
    const p = (k: string) => {
      const m = k.match(/^P(\d)/);
      return m ? Number(m[1]) : 9;
    };
    return p(a.implementation_priority) - p(b.implementation_priority);
  });

  return {
    read_only: true,
    no_db_writes: true,
    no_generator_implementation: true,
    no_claim_submission: true,
    generated_at: new Date().toISOString(),
    version: "v3",
    family_count: V3_CLAIM_FAMILY_COUNT,
    classification_counts: countClassifications(),
    hard_rules: CLAIM_ALGORITHM_HARD_RULES,
    implementation_priority: IMPLEMENTATION_PRIORITY_V3,
    first_safe_5_families: FIRST_SAFE_5_FAMILIES_V3,
    removed_or_merged_families: REMOVED_OR_MERGED_FAMILIES,
    official_report_type_mapping: OFFICIAL_REPORT_TYPE_MAPPING,
    missing_source_mapping: MISSING_SOURCE_MAPPING,
    ai_optional: {
      capability_matrix: AI_OPTIONAL_CAPABILITY_MATRIX,
      not_required_guards: AI_NOT_REQUIRED_GUARDS,
      feature_flags_checked: {
        sources: AI_FEATURE_FLAG_SOURCES,
        ai_module_access: aiAccess,
        ai_required_for_core_readmodel: false,
        ai_effectively_ready: aiReady,
        behavior_when_ai_disabled: AI_DISABLED_BEHAVIOR,
        behavior_when_ai_enabled: AI_ENABLED_BEHAVIOR,
      },
    },
    families,
  };
}

export type { AiOptionalCapability, AiNotRequiredGuard };
