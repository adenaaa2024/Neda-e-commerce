/**
 * PHASE-CLAIM-AI-ASSISTED-OPERATIONS-PLAN-V1
 * Planning contract — advisory AI overlays only; never production truth.
 */
import fs from "node:fs";
import path from "node:path";

import {
  AI_DISABLED_BEHAVIOR,
  AI_ENABLED_BEHAVIOR,
  AI_NOT_REQUIRED_GUARDS,
  AI_OPTIONAL_CAPABILITY_MATRIX,
} from "../contracts/claim-family-ai-optional-contract-v1";

export const CLAIM_AI_ASSISTED_OPERATIONS_PLAN_V1 = "claim-ai-assisted-operations-plan-v1" as const;

/** Mirrors live reference audit catalog — planning reference only. */
const MISSING_LIVE_API_ENDPOINTS_CATALOG = [
  "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA",
  "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA",
  "GET_FBA_REIMBURSEMENTS_DATA",
  "GET_V2_SETTLEMENT_REPORT_DATA_V2",
] as const;

export type AiFeatureRisk = "low" | "medium" | "high";

export type RecommendedAiFeature = {
  id: string;
  name: string;
  status: "recommended";
  risk_level: AiFeatureRisk;
  rationale: string;
  deterministic_prerequisite: string;
  human_review: string[];
  ui_location: string;
  data_sources: string[];
  implementation_phase: number;
};

export type RejectedAiFeature = {
  id: string;
  name: string;
  status: "rejected";
  reason: string;
};

export type ClaimAiAssistedOperationsPlanResult = {
  version: typeof CLAIM_AI_ASSISTED_OPERATIONS_PLAN_V1;
  mode: "ai-feature-planning-only";
  recommended_ai_features: RecommendedAiFeature[];
  rejected_ai_features: RejectedAiFeature[];
  safe_ai_boundaries: string[];
  human_review_required_points: string[];
  audit_logging_plan: string[];
  data_sources_needed: string[];
  ui_locations: string[];
  risk_level_per_feature: Record<string, AiFeatureRisk>;
  implementation_order: string[];
  no_db_write_verification: true;
  no_amazon_submission_verification: true;
  no_scanner_change_verification: boolean;
  SAFE_TO_BUILD_AI_EVIDENCE_SUMMARY: boolean;
  SAFE_TO_BUILD_AI_REFERENCE_GAP_DETECTOR: boolean;
  SAFE_TO_BUILD_AI_DRAFT_HELPER: boolean;
  NEXT_PROMPT: string;
  planning_context?: {
    ai_optional_contract: Record<string, unknown>;
    live_reference_audit_present: boolean;
    simulation_verify_present: boolean;
  };
};

const RECOMMENDED: RecommendedAiFeature[] = [
  {
    id: "evidence_summary_assistant",
    name: "Evidence summary assistant",
    status: "recommended",
    risk_level: "low",
    rationale:
      "Read-only summarization over existing evidence packet + reference graph; aligns with AI_OPTIONAL_CAPABILITY_MATRIX.evidence_summary.",
    deterministic_prerequisite:
      "claim_evidence + filing packet preview + materialized claim_reference_edges must load without AI.",
    human_review: [
      "Operator must confirm summary before citing in Seller Central",
      "AI must not add facts not present in cited source rows",
    ],
    ui_location:
      "Reimbursement Tracking detail drawer → Evidence tab; Filing packet preview panel; Case review detail",
    data_sources: [
      "claim_evidence",
      "claim_reference_edges",
      "evidence_packet_snapshot",
      "export_artifact_paths",
      "return_items.photo_evidence (read-only URLs)",
    ],
    implementation_phase: 1,
  },
  {
    id: "reference_gap_detector",
    name: "Reference gap detector",
    status: "recommended",
    risk_level: "medium",
    rationale:
      "Deterministic gap detection from TRID contract + live reference audit; AI may only explain gaps and suggest report pulls — never invent IDs.",
    deterministic_prerequisite:
      "PHASE-CLAIM-LIVE-REFERENCE-API-COMPLETION-AUDIT-V1 coverage matrix + FAMILY_EDGE_REQUIREMENTS.",
    human_review: [
      "Suggested report/API pulls are advisory",
      "Operator approves any sync trigger",
    ],
    ui_location:
      "Reimbursement Tracking drawer → Overview (reference graph); Claim Center References tab; Filing handoff modal",
    data_sources: [
      "claim_reference_edges",
      "claim-live-reference-api-completion-audit reference_coverage_matrix",
      "CLAIM_FAMILY_MATRIX_V3 required_reports_api",
      "missing_live_api_endpoints catalog",
    ],
    implementation_phase: 2,
  },
  {
    id: "claim_packet_draft_helper",
    name: "Claim packet draft helper",
    status: "recommended",
    risk_level: "medium",
    rationale:
      "Internal filing notes + Amazon-facing draft text only; extends case_narrative_draft with explicit human-review gate before copy/paste.",
    deterministic_prerequisite:
      "Filing packet export + manual filing guarded execute path; draft status on claim_submissions unchanged until operator executes.",
    human_review: [
      "All Amazon-facing text marked DRAFT — NOT SUBMITTED",
      "Operator copies manually to Seller Central",
      "No auto-submit endpoint",
    ],
    ui_location:
      "Manual filing modal (preview tab); Filing packet preview → Draft helper side panel",
    data_sources: [
      "claim_filing_packet_preview",
      "claim_submissions.source_payload",
      "family_key_v3 + quantity_formula from algorithm matrix",
    ],
    implementation_phase: 3,
  },
  {
    id: "slip_ocr_helper",
    name: "Slip/OCR helper",
    status: "recommended",
    risk_level: "high",
    rationale:
      "Extract candidate VRET/LPN/slip refs with confidence scores; materialization blocked until operator confirms — VRET audit proved unsafe auto-link.",
    deterministic_prerequisite:
      "OCR pipeline exists separately; claim_reference_edges writes remain governed execute only.",
    human_review: [
      "Every extracted identifier requires confirm/reject",
      "No auto product_link or claim_reference_edges insert from OCR",
      "VRET not used as order_id/TRID without DB hit",
    ],
    ui_location: "Evidence tab → Scan slip assistant; Operator mobile evidence upload review (read-only bridge)",
    data_sources: [
      "scanner photo_evidence storage paths",
      "claim_evidence",
      "phase-claim-vret-slip-reference-mapping-audit findings",
    ],
    implementation_phase: 5,
  },
  {
    id: "reimbursement_matching_assistant",
    name: "Reimbursement matching assistant",
    status: "recommended",
    risk_level: "medium",
    rationale:
      "Explain deterministic matchReimbursementRows results; flag candidates — never auto-close or write observed_reimbursement without execute approval.",
    deterministic_prerequisite:
      "claim-reimbursement-tracking-preview-v1 match rules + amazon_case_id post-filing.",
    human_review: [
      "Operator confirms match before updating tracking status",
      "AI explanation cites match_reason from deterministic engine",
    ],
    ui_location: "Reimbursement Tracking drawer → Money tab; Reimbursement match candidates list",
    data_sources: [
      "amazon_reimbursements",
      "amazon_transactions",
      "amazon_settlements",
      "reimbursement_match_candidates from tracking preview",
    ],
    implementation_phase: 4,
  },
  {
    id: "anomaly_detector",
    name: "Anomaly detector",
    status: "recommended",
    risk_level: "low",
    rationale:
      "Rule-based anomaly flags first (NULL COGS, qty mismatch, duplicate refs); AI explains anomalies only — does not change money lanes.",
    deterministic_prerequisite:
      "Money lane preview + reference coverage + clean/disputed EP rules.",
    human_review: [
      "Anomaly explanations are advisory",
      "Money values remain NULL/Unknown when deterministic lanes say so",
    ],
    ui_location:
      "Reimbursement Tracking summary cards; Money tab warnings; Claim Center command home attention list",
    data_sources: [
      "claim-money-lane-preview-v2",
      "cogs_overrides",
      "expected_packages build_status",
      "reference_coverage_matrix",
    ],
    implementation_phase: 2,
  },
];

const REJECTED: RejectedAiFeature[] = [
  {
    id: "ai_auto_amazon_submit",
    name: "Automatic Amazon claim submission",
    status: "rejected",
    reason: "Violates submission_authorization guard; manual filing execute is operator-gated only.",
  },
  {
    id: "ai_product_link_creation",
    name: "AI-created product links from title/OCR",
    status: "rejected",
    reason: "Violates product_linkage guard and FORBIDDEN_ACTIONS — product_identifier_map exact match only.",
  },
  {
    id: "ai_cogs_or_amount_truth",
    name: "AI as COGS / recovery / reimbursement source of truth",
    status: "rejected",
    reason: "Violates amount_calculation guard; approved COGS and observed reimb are deterministic lanes.",
  },
  {
    id: "ai_reference_graph_override",
    name: "AI override of materialized reference graph",
    status: "rejected",
    reason: "claim_reference_edges are governed materialization only; AI cannot mutate edges without execute phase.",
  },
  {
    id: "ai_auto_close_claim",
    name: "Auto-close claim on AI reimb match",
    status: "rejected",
    reason: "Reimbursement matching requires human review; status transitions via guarded execute.",
  },
  {
    id: "ai_unattended_db_writes",
    name: "Unattended AI DB writes",
    status: "rejected",
    reason: "All mutations require operator approval files + execute scripts per pilot pattern.",
  },
];

const SAFE_AI_BOUNDARIES = [
  "AI output is advisory only — never merged into claim_submissions, claim_cases, or money_lanes as truth.",
  "AI must cite underlying source_table + source_row_id or file path for every factual claim.",
  "AI cannot create product links — resolver uses product_identifier_map only.",
  "AI cannot generate final Amazon submission text without DRAFT watermark + human attestation.",
  "AI cannot mutate DB — writes stay in governed execute phases with operator approvals.",
  "AI cannot override deterministic claim_reference_edges or reimbursement match rules.",
  "When ai_assistant module disabled or API key missing → deterministic_only (AI_DISABLED_BEHAVIOR).",
  "Pilot/simulation mode (?simulation=1) must disable or clearly label any AI overlay as non-production.",
  ...Object.values(AI_NOT_REQUIRED_GUARDS).map((g) => g.rule),
];

const HUMAN_REVIEW_POINTS = [
  "Evidence summary before external citation",
  "Amazon-facing draft text before Seller Central paste",
  "OCR/slip extracted identifiers before any edge materialization",
  "Reimbursement match acceptance before status → reimbursed",
  "COGS values — always operator-approved unit costs, never AI-inferred",
  "Manual filing execute — amazon_case_id from Seller Central, not AI",
  "Any proposed reference sync trigger from gap detector",
];

const AUDIT_LOGGING_PLAN = [
  "Table: claim_ai_assistant_runs (proposed additive) — organization_id, user_id, feature_id, model_id, prompt_hash, input_refs JSONB, output_text, citations JSONB, human_reviewed_at, human_reviewed_by, rejected_at.",
  "Append-only — no hard delete; soft-delete via rejected_at only.",
  "Log every model call with pilot_case_run_id / claim_submission_id scope when present.",
  "Store deterministic baseline snapshot hash alongside AI output for diff audit.",
  "RLS: organization_id scoped; service_role insert from API route only after RBAC check.",
  "Retention: align with audit_logs policy; PII-minimal (no raw slip images in log — storage path ref only).",
  "Feature flag: module_configs.ai_assistant.log_all_calls default true for enterprise.",
];

const DATA_SOURCES_NEEDED = [
  ...new Set([
    ...RECOMMENDED.flatMap((f) => f.data_sources),
    "workspace_settings.module_configs.ai_assistant",
    "GET /api/claims/center/ai-access",
    "claim_evidence_packet_composer output",
    "reports_repository + raw_report_uploads lineage",
  ]),
];

const UI_LOCATIONS = [...new Set(RECOMMENDED.map((f) => f.ui_location))];

function fileExists(rel: string): boolean {
  return fs.existsSync(path.join(process.cwd(), rel));
}

export function verifyAiAssistedOperationsPlanStatic(): boolean {
  return (
    fileExists("lib/claims/contracts/claim-family-ai-optional-contract-v1.ts") &&
    fileExists("app/api/claims/center/ai-access/route.ts") &&
    fileExists("components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx") &&
    RECOMMENDED.length === 6 &&
    REJECTED.length >= 4
  );
}

export function buildClaimAiAssistedOperationsPlanV1(): ClaimAiAssistedOperationsPlanResult {
  const risk_level_per_feature = Object.fromEntries(
    RECOMMENDED.map((f) => [f.id, f.risk_level]),
  ) as Record<string, AiFeatureRisk>;

  const implementation_order = [...RECOMMENDED]
    .sort((a, b) => a.implementation_phase - b.implementation_phase)
    .map((f) => `${f.implementation_phase}. ${f.name} (${f.id})`);

  const liveAuditEvidence = fileExists(
    ".cursor/audit-reports/phase-claim-live-reference-api-completion-audit-v1",
  );
  const simulationVerifyEvidence = fileExists(
    ".cursor/audit-reports/phase-claim-pilot-simulation-verify-v1",
  );

  const SAFE_TO_BUILD_AI_EVIDENCE_SUMMARY =
    verifyAiAssistedOperationsPlanStatic() && Boolean(AI_OPTIONAL_CAPABILITY_MATRIX.evidence_summary);

  const SAFE_TO_BUILD_AI_REFERENCE_GAP_DETECTOR =
    verifyAiAssistedOperationsPlanStatic() &&
    liveAuditEvidence &&
    MISSING_LIVE_API_ENDPOINTS_CATALOG.length > 0;

  const SAFE_TO_BUILD_AI_DRAFT_HELPER =
    verifyAiAssistedOperationsPlanStatic() &&
    Boolean(AI_OPTIONAL_CAPABILITY_MATRIX.case_narrative_draft) &&
    fileExists("components/claim-center/reimbursement-tracking/ReimbursementTrackingManualFilingModal.tsx");

  return {
    version: CLAIM_AI_ASSISTED_OPERATIONS_PLAN_V1,
    mode: "ai-feature-planning-only",
    recommended_ai_features: RECOMMENDED,
    rejected_ai_features: REJECTED,
    safe_ai_boundaries: SAFE_AI_BOUNDARIES,
    human_review_required_points: HUMAN_REVIEW_POINTS,
    audit_logging_plan: AUDIT_LOGGING_PLAN,
    data_sources_needed: DATA_SOURCES_NEEDED,
    ui_locations: UI_LOCATIONS,
    risk_level_per_feature,
    implementation_order,
    no_db_write_verification: true,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: true,
    SAFE_TO_BUILD_AI_EVIDENCE_SUMMARY,
    SAFE_TO_BUILD_AI_REFERENCE_GAP_DETECTOR,
    SAFE_TO_BUILD_AI_DRAFT_HELPER,
    NEXT_PROMPT: SAFE_TO_BUILD_AI_EVIDENCE_SUMMARY
      ? "PHASE-CLAIM-CENTER-AI-OPTIONAL-OVERLAY-SHELL-V1 — UI shell + dry-run panels (no model calls); then PHASE-CLAIM-AI-EVIDENCE-SUMMARY-ASSISTANT-V1 read-only pilot"
      : "Fix AI plan prerequisites and re-run phase",
    planning_context: {
      ai_optional_contract: {
        disabled: AI_DISABLED_BEHAVIOR.mode,
        enabled: AI_ENABLED_BEHAVIOR.mode,
        human_approval_required: AI_ENABLED_BEHAVIOR.human_approval_required_for,
      },
      live_reference_audit_present: liveAuditEvidence,
      simulation_verify_present: simulationVerifyEvidence,
    },
  };
}
