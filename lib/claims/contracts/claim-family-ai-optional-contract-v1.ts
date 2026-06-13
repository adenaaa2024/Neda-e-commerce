/**
 * PHASE-CLAIM-FAMILY-V3-READMODEL-AND-AI-OPTIONAL-CONTRACT-V1
 * AI/GPT optional assistance contract — never required for deterministic claim paths.
 */

export type AiOptionalCapability =
  | "evidence_summary"
  | "case_narrative_draft"
  | "source_mismatch_explanation"
  | "review_reason_classification"
  | "human_readable_claim_recommendation"
  | "anomaly_explanation";

export type AiNotRequiredGuard =
  | "source_ingestion"
  | "product_linkage"
  | "clean_disputed_classification"
  | "claim_ready_decision"
  | "amount_calculation"
  | "deadline_window_enforcement"
  | "submission_authorization";

export const AI_OPTIONAL_CAPABILITY_MATRIX: Record<
  AiOptionalCapability,
  { description: string; input_sources: string[]; output_type: string; requires_human_approval: boolean }
> = {
  evidence_summary: {
    description: "Summarize attached evidence images, report rows, and scanner notes for operator review",
    input_sources: ["evidence_packet", "return_items.photo_evidence", "report row excerpts"],
    output_type: "markdown_summary",
    requires_human_approval: true,
  },
  case_narrative_draft: {
    description: "Draft Seller Central / SAFE-T case narrative from structured family + quantity + evidence",
    input_sources: ["claim_family_matrix_v3", "quantity_formula", "TRID edges", "evidence_summary"],
    output_type: "draft_text",
    requires_human_approval: true,
  },
  source_mismatch_explanation: {
    description: "Explain why ledger vs manage_fba vs settlement quantities disagree in plain language",
    input_sources: ["lifecycle_quantities", "source_row_counts", "disputed_bucket"],
    output_type: "explanation_text",
    requires_human_approval: false,
  },
  review_reason_classification: {
    description: "Classify review_signal reason labels (linkage unresolved, disputed EP, stale source, fee spine gap)",
    input_sources: ["missing_inputs", "confidence_reasons", "linkage_status"],
    output_type: "review_label",
    requires_human_approval: false,
  },
  human_readable_claim_recommendation: {
    description: "Operator-facing recommendation text — never overrides deterministic claim-ready gate",
    input_sources: ["algorithm_matrix_v3_entry", "implementation_priority", "blockers"],
    output_type: "recommendation_text",
    requires_human_approval: true,
  },
  anomaly_explanation: {
    description: "Explain settlement/refund/reimbursement anomalies vs fee-adjusted estimate lanes",
    input_sources: ["fee_adjusted_estimate", "observed_reimbursement", "estimated_amazon_payout"],
    output_type: "explanation_text",
    requires_human_approval: false,
  },
};

export const AI_NOT_REQUIRED_GUARDS: Record<
  AiNotRequiredGuard,
  { rule: string; deterministic_owner: string }
> = {
  source_ingestion: {
    rule: "Amazon report/API sync and file importers must complete without AI",
    deterministic_owner: "AMAZON_REPORT_REGISTRY + UniversalImporter",
  },
  product_linkage: {
    rule: "product_identifier_map exact match required — no title/OCR/auto-create",
    deterministic_owner: "product_identifier_map + ProductLinkageDisplayContract",
  },
  clean_disputed_classification: {
    rule: "expected_packages build_status gating — disputed rows never claim-ready",
    deterministic_owner: "lib/expected-packages-conflict-status.ts",
  },
  claim_ready_decision: {
    rule: "create_candidate vs review_signal from classification + source availability + policy",
    deterministic_owner: "claim-family-algorithm-matrix-v3 + intake policy",
  },
  amount_calculation: {
    rule: "quantity/money/fee-adjusted payout from computeFeeAdjustedMoneyOutput — NULL when unknown",
    deterministic_owner: "claim-family-quantity-money-formula-contract-v2 + fee-adjusted-estimate-readmodel",
  },
  deadline_window_enforcement: {
    rule: "claim_window / expired / closing_soon from deriveClaimLifecycleStatus",
    deterministic_owner: "claim-intake-policy-contract",
  },
  submission_authorization: {
    rule: "Case submission requires explicit operator action + RBAC — AI drafts are not submissions",
    deterministic_owner: "claim_submissions bridge + Platform Access",
  },
};

export const AI_FEATURE_FLAG_SOURCES = [
  "workspace_settings.module_configs.ai_assistant.enabled",
  "workspace_settings.module_configs.ai_agents (Menorix entitlements)",
  "organization_settings.claim_policy (no AI override fields)",
  "env OPENAI_API_KEY / AZURE_OPENAI_API_KEY / ANTHROPIC_API_KEY presence",
] as const;

export const AI_DISABLED_BEHAVIOR = {
  mode: "deterministic_only",
  description:
    "When AI module locked or API key missing, return rule-based matrix + formulas only. No model calls. No blocked core paths.",
  capabilities_available: [] as AiOptionalCapability[],
  capabilities_unavailable_note: "Enable ai_assistant module + provider key for optional draft/summary features.",
} as const;

export const AI_ENABLED_BEHAVIOR = {
  mode: "deterministic_plus_optional_ai",
  description:
    "Deterministic readmodel always returned. AI capabilities are additive overlays — never gate claim-ready or money.",
  capabilities_available: Object.keys(AI_OPTIONAL_CAPABILITY_MATRIX) as AiOptionalCapability[],
  human_approval_required_for: [
    "evidence_summary",
    "case_narrative_draft",
    "human_readable_claim_recommendation",
  ],
} as const;

export const SAFE_TO_IMPLEMENT_AI_OPTIONAL_OVERLAY = "yes" as const;

export const NEXT_PROMPT_AI_OPTIONAL = `PHASE-CLAIM-CENTER-AI-OPTIONAL-OVERLAY-SHELL-V1

Mode: UI shell only — show AI optional badges on Claim Center detail when ai_access.state=ready.
Wire evidence_summary + case_narrative_draft as draft-only panels (no auto-submit).
Do not call models from algorithm-matrix-v3 endpoint.` as const;
