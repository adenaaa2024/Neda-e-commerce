/**
 * PHASE-CLAIM-FILING-PACKET-PLAN-V1
 * Read-only filing packet contract for trusted pilot claim_cases.
 * No PDF. No export. No claim_submission. No DB writes.
 */
export const CLAIM_FILING_PACKET_V1_PLAN_VERSION = "claim-filing-packet-v1-plan" as const;

export const PILOT_CASE_RUN_ID = "pilot-20260615T190000Z" as const;
export const PILOT_INTAKE_RUN_ID = "a8a892fe-37d5-4d74-9ea2-02af8fd095ce" as const;
export const ORIGINAL_REF = "kxsvedvpjldygtdbylsy" as const;

export const PDF_GENERATION_DEFERRED = {
  deferred: true,
  reason: "Filing packet V1 is plan/preview only — PDF/export after operator approval",
  future_phase: "PHASE-CLAIM-FILING-PACKET-PREVIEW-V1 or PHASE-CLAIM-FILING-PACKET-PDF-V1",
} as const;

export const FILING_PACKET_SCHEMA_PROPOSAL = {
  version: CLAIM_FILING_PACKET_V1_PLAN_VERSION,
  anchor: "claim_case_id (trusted open pilot case)",
  layers: [
    "case_identity",
    "candidate_line_data",
    "evidence_block",
    "money_block",
    "filing_narrative",
    "attachments_block",
    "readiness",
    "submission_safety",
  ],
  persistence: "none — ephemeral plan compose from claim_cases.metadata.evidence_packet_snapshot",
  reuse: [
    "lib/claims/pilot/claim-case-review-readmodel.ts",
    "lib/claims/evidence/claim-evidence-packet-v1.ts snapshot shape",
    "lib/claims/evidence/claim-evidence-packet-v1-plan-contract.ts MONEY_RULES",
  ],
  deferred: ["PDF", "claim_submissions INSERT", "Amazon API"],
} as const;

export const REQUIRED_CASE_FIELDS = [
  "claim_case_id",
  "pilot_case_run_id",
  "intake_run_id",
  "claim_family",
  "claim_source",
  "claim_subtype",
  "status",
  "idempotency_key",
  "candidate_ids",
  "source_event_key",
  "operator_review_attested",
  "evidence_packet_snapshot",
] as const;

export const REQUIRED_LINE_FIELDS = [
  "claim_line_id",
  "claim_candidate_id",
  "quantity_expected",
  "clean_quantity",
  "line_idempotency_key",
  "line_status",
] as const;

export const EVIDENCE_REQUIREMENTS = {
  required: [
    "evidence_packet_snapshot",
    "source_event_key",
    "source_event_date",
    "date_gate.date_gate_passed = true",
    "operator_review_attested = true",
  ],
  optional_pointers: [
    "expected_packages",
    "amazon_removals",
    "amazon_removal_shipments",
    "claim_reference_edges",
  ],
  photo_evidence: {
    required_for_families: [] as string[],
    warning_for_removal_api_families: [
      "removal_shipment_missing",
      "removal_order_discrepancy",
    ],
    note: "Pilot removal/API families — photo evidence warning only, not blocker",
  },
} as const;

export const MONEY_RULES = {
  lanes: [
    "estimated_amazon_payout",
    "observed_reimbursement",
    "internal_cost_loss",
    "recovery_value",
    "reimbursement_gap",
    "expected_amount",
  ],
  null_rule: "NULL stays NULL in JSON and UI — never coerce to 0",
  sale_price_rule: "Sale price / list_price display-only — NEVER substitute for COGS or estimated payout",
  missing_fee: "warning only (missing_fee)",
  missing_cost: "warning only (missing_cost)",
  sum_rule: "Do not sum null lanes for filing totals",
} as const;

export const NARRATIVE_RULES = {
  internal_summary: "Deterministic template from family_key_v3 + source_event_key + product ids + clean qty",
  amazon_facing_draft: "Template placeholder only — no AI/GPT; no final submission wording",
  ai_generation: "forbidden",
  templates: {
    removal_shipment_missing:
      "Removal shipment missing/incomplete delivery — tracking/shipment {source_event_key}. Product {product_ids}. Clean quantity {clean_quantity}. Supporting removal shipment and expected package records attached in evidence snapshot.",
    removal_order_discrepancy:
      "Removal order discrepancy — source {source_event_key}. Product {product_ids}. Clean quantity {clean_quantity}. Supporting removal order and shipment reference records in evidence snapshot.",
  },
} as const;

export const ATTACHMENT_RULES = {
  pdf_export: "deferred",
  photo_evidence: "warning_if_missing_for_removal_families",
  scanner_photo: "not_required_for_pilot_removal_families",
  allowed_warnings: ["missing_photo_evidence", "missing_evidence"],
} as const;

export const READINESS_RULES = {
  ready_for_filing_packet_requires: [
    "status = open",
    "not remediation_duplicate",
    "all REQUIRED_CASE_FIELDS present",
    "all REQUIRED_LINE_FIELDS present per line",
    "date_gate_passed = true",
    "operator_review_attested = true",
    "no active claim_submission on case",
  ],
  blockers: [
    "case_not_open",
    "remediated_duplicate",
    "missing_required_field",
    "date_gate_failed",
    "operator_not_attested",
    "active_submission_exists",
  ],
  warnings_only: [
    "missing_fee",
    "missing_cost",
    "missing_photo_evidence",
    "missing_evidence",
    "money_lane_null",
  ],
  exclude: ["closed", "remediated", "superseded duplicate cases"],
} as const;

export const DUPLICATE_SUBMISSION_SAFETY_RULES = {
  no_packet_for_closed_cases: true,
  no_packet_for_remediation_duplicates: true,
  no_packet_when_active_submission: "unless explicit re-export approval (out of scope V1)",
  no_amazon_submission_in_phase: true,
  no_claim_submissions_insert: true,
  pilot_scope: `case_creation_origin + pilot_case_run_id + intake_run_id + status=open`,
} as const;

export type ClaimFilingPacketV1CaseIdentity = {
  claim_case_id: string;
  pilot_case_run_id: string | null;
  intake_run_id: string | null;
  claim_family: string | null;
  claim_source: string | null;
  claim_subtype: string | null;
  family_key_v3: string | null;
  status: string | null;
  idempotency_key: string | null;
};

export type ClaimFilingPacketV1LineData = {
  candidate_ids: string[];
  claim_line_ids: string[];
  product_identifiers: {
    asin: string | null;
    fnsku: string | null;
    sku: string | null;
    resolved_product_id: string | null;
  };
  clean_quantity: number | null;
  source_event_key: string | null;
  source_event_date: string | null;
};

export type ClaimFilingPacketV1Evidence = {
  evidence_packet_snapshot: Record<string, unknown> | null;
  evidence_summary: string | null;
  reference_edges: Array<{
    id: string;
    edge_type: string | null;
    reference_kind: string | null;
    reference_value: string | null;
  }>;
  source_pointers: {
    expected_packages: unknown;
    amazon_removals: unknown;
    amazon_removal_shipments: unknown;
  };
  date_gate: Record<string, unknown> | null;
  operator_attestation: {
    attested: boolean;
    attested_by: string | null;
    attested_at: string | null;
  };
};

export type ClaimFilingPacketV1Money = {
  estimated_amount: number | null;
  recovery_value: number | null;
  observed_reimbursement: number | null;
  internal_cost_loss: number | null;
  money_lanes: Record<string, unknown>;
  null_preservation: true;
};

export type ClaimFilingPacketV1Narrative = {
  internal_filing_summary: string;
  amazon_facing_draft_text: string;
  template_id: string;
  ai_generated: false;
};

export type ClaimFilingPacketV1Attachments = {
  pdf_export_deferred: true;
  photo_evidence_required: false;
  photo_evidence_warning: boolean;
};

export type ClaimFilingPacketV1Readiness = {
  ready_for_filing_packet: boolean;
  blockers: string[];
  warnings: string[];
};

export type ClaimFilingPacketV1SubmissionSafety = {
  excluded_reason: string | null;
  has_active_submission: boolean;
  claim_submission_id: string | null;
};

export type ClaimFilingPacketV1Plan = {
  version: typeof CLAIM_FILING_PACKET_V1_PLAN_VERSION;
  composed_at: string;
  case_identity: ClaimFilingPacketV1CaseIdentity;
  line_data: ClaimFilingPacketV1LineData;
  evidence: ClaimFilingPacketV1Evidence;
  money: ClaimFilingPacketV1Money;
  narrative: ClaimFilingPacketV1Narrative;
  attachments: ClaimFilingPacketV1Attachments;
  readiness: ClaimFilingPacketV1Readiness;
  submission_safety: ClaimFilingPacketV1SubmissionSafety;
};
