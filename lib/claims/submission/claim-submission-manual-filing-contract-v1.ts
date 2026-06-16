/**
 * PHASE-CLAIM-SUBMISSION-MANUAL-FILING-CONTRACT-V1
 * Read-only contract for manual filing handoff and claim_submissions boundary.
 * No INSERT. No Amazon API. No upload.
 */
import type { ClaimFilingPacketPreviewV1 } from "../filing/claim-filing-packet-preview-v1";
import { assessPdfExportEligibility } from "../filing/claim-pdf-export-preview-contract-v1";
import {
  DUPLICATE_SUBMISSION_SAFETY_RULES,
  ORIGINAL_REF,
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";

export const CLAIM_SUBMISSION_MANUAL_FILING_CONTRACT_V1_VERSION =
  "claim-submission-manual-filing-contract-v1" as const;

export const SUBMISSION_MODES_CONTRACT = {
  manual_filing_handoff: {
    id: "manual_filing_handoff",
    enabled_in_contract: true,
    description:
      "Operator reviews draft packet (HTML/JSON/PDF), files manually on Amazon portal, records external reference later",
    amazon_api: false,
    browser_automation: false,
    creates_claim_submission: "deferred — separate approved pilot phase only",
  },
  future_amazon_api_submission: {
    id: "future_amazon_api_submission",
    enabled_in_contract: false,
    description: "SP-API / agent portal submission — explicitly disabled until operator+Maysam approval",
    amazon_api: false,
    note: "OUT OF SCOPE for pilot V1",
  },
  export_only_mode: {
    id: "export_only_mode",
    enabled_in_contract: true,
    description: "Generate local draft artifacts only; no submission row; current PDF export pilot",
    creates_claim_submission: false,
  },
  tracking_only_mode: {
    id: "tracking_only_mode",
    enabled_in_contract: true,
    description: "Post-manual-filing: record external Amazon case id + reimbursement observation without re-submitting",
    creates_claim_submission: "optional update to existing row — future phase",
    links_to: ["claim_submissions.submission_id", "amazon_reimbursements observed lane"],
  },
} as const;

/** Proposed pilot extension — NOT applied in this contract phase. */
export const CLAIM_SUBMISSIONS_USAGE_CONTRACT = {
  when_to_create_row: [
    "Operator explicitly approves PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1",
    "claim_case is open canonical pilot case with ready_for_manual_filing",
    "draft packet export reviewed (export_run_id recorded)",
    "no active submission exists for claim_case_id",
    "manual filing handoff checklist attested",
  ],
  required_fields_proposed: {
    organization_id: "UUID NOT NULL — tenant scope",
    store_id: "UUID NOT NULL — sales channel",
    claim_case_id: "UUID NOT NULL — pilot case anchor (new column or source_payload.claim_case_id)",
    idempotency_key: "text NOT NULL — claim_case_id + pilot_case_run_id + filing_mode",
    status: "enum — see status_values",
    source_payload: "JSONB — filing packet snapshot ref, export_run_id, warnings, money lanes NULL preserved",
    submission_id: "text NULL — Amazon external case id (filled after manual filing, not at create)",
    report_url: "text NULL — local audit path or future signed URL; pilot uses local path only",
    filing_mode: "manual_handoff_v1",
    export_run_id: "links to phase-claim-pdf-export-preview-pilot-v1 run folder",
    manual_external_reference: "operator-entered portal reference (deferred UI phase)",
    amazon_case_id: "alias of submission_id for Amazon Seller Central case id",
  },
  status_values: {
    draft: "Record created; packet attached; not filed externally",
    ready_to_send: "Operator marked ready for manual portal filing (legacy enum reuse)",
    submitted: "Operator confirmed filed on Amazon portal — manual attestation only",
    investigating: "Awaiting Amazon response / reimbursement tracking",
    accepted: "Amazon accepted claim",
    rejected: "Amazon rejected claim",
    evidence_requested: "Amazon requested more evidence — manual follow-up",
    cancelled: "Soft-cancelled submission record — no hard delete",
  },
  idempotency_key_pattern:
    "manual-filing-v1:{claim_case_id}:{pilot_case_run_id}:{export_run_id}",
  linked_claim_case_id: "One active non-cancelled submission per claim_case_id",
  linked_export_run_id: "Immutable pointer to reviewed draft export folder",
  manual_external_reference_fields: [
    "submission_id",
    "source_payload.manual_filing_notes",
    "source_payload.portal_filed_at",
    "source_payload.operator_filed_by",
  ],
  amazon_case_id_fields: ["submission_id", "source_payload.amazon_case_id"],
  legacy_return_id_note:
    "Existing 3 claim_submissions rows use return_id linkage — pilot cases use claim_case_id anchor; do not mix without migration approval",
  this_phase: "contract only — zero INSERT",
} as const;

export const MANUAL_FILING_HANDOFF_CONTRACT = {
  operator_sees: [
    "Filing packet preview (Case Review drawer)",
    "Readiness badges: ready_for_manual_filing / needs_review / blocked",
    "Local draft artifacts: HTML, JSON, TXT, PDF (DRAFT watermarked)",
    "Warnings list (fee/cost/photo/evidence) — informational",
    "Checklist: draft reviewed, quantities verified, product identity confirmed",
    "Explicit banner: NOT SUBMITTED TO AMAZON",
  ],
  files_provided: [
    "HTML preview (printable)",
    "JSON export (audit)",
    "TXT summary",
    "PDF draft (local Playwright render)",
    "summary.csv batch manifest from export pilot",
  ],
  operator_must_copy_manually: [
    "Product identifiers (ASIN/FNSKU/SKU)",
    "Source event key / removal reference",
    "Clean quantity",
    "Internal filing summary text (deterministic template — not AI)",
    "Evidence pointers from snapshot (portal-specific fields per Amazon UI)",
  ],
  explicitly_not_automated: [
    "Amazon SP-API submission",
    "Browser automation / portal login",
    "Auto-create claim_submissions on export",
    "Auto-upload to Supabase Storage",
    "AI/GPT narrative generation",
    "Reimbursement ingestion (uses existing amazon_reimbursements read lane)",
  ],
  handoff_boundary:
    "Internal draft packet ends at local export folder; manual filing begins when operator leaves Menorix to Amazon portal",
} as const;

export const SAFETY_RULES = {
  no_automatic_amazon_submission: true,
  no_browser_automation: true,
  no_ai_gpt_text: true,
  blocked_cases_cannot_submit: true,
  warnings_display_not_block: [
    "missing_fee",
    "missing_cost",
    "missing_photo_evidence",
    "missing_evidence",
  ],
  draft_packet_must_be_reviewed: true,
  review_evidence: "export_run_id + operator attestation on claim_case required before submission record pilot",
  duplicate_submission_prevention: DUPLICATE_SUBMISSION_SAFETY_RULES,
  closed_remediated_excluded: true,
  claim_submissions_insert_this_phase: false,
} as const;

export const UI_REQUIREMENTS_NEXT_PHASE = {
  create_manual_filing_record: {
    label: "Create manual filing record",
    default_state: "disabled",
    enabled_when: "SAFE_TO_CREATE_CLAIM_SUBMISSION_RECORD_PILOT=yes + operator approval artifact",
  },
  mark_as_filed: {
    label: "Mark as filed (manual attestation)",
    default_state: "disabled",
    enabled_when: "submission record exists + operator confirms portal filing",
  },
  amazon_submit: {
    label: "Submit to Amazon",
    default_state: "disabled",
    enabled_when: "never in pilot V1 — future gated phase",
  },
  add_external_reference: {
    label: "Add external reference",
    default_state: "disabled",
    enabled_when: "after mark_as_filed approval phase",
  },
  track_reimbursement: {
    label: "Track reimbursement",
    default_state: "disabled",
    enabled_when: "after submission_id recorded — links to observed reimbursement lane",
  },
  export_draft_packet: {
    label: "Export draft packet",
    default_state: "read-only link to local export folder / re-run export",
    enabled_when: "SAFE_PDF_EXPORT_PREVIEW_READY=yes",
  },
} as const;

export type ManualFilingReadinessState =
  | "ready_for_manual_filing"
  | "needs_review"
  | "blocked"
  | "already_submitted"
  | "duplicate_submission_risk";

export const READINESS_RULES = {
  ready_for_manual_filing: {
    requires: [
      "preview.readiness.ready_for_manual_filing = true",
      "preview.blockers.length = 0",
      "case_status = open",
      "not remediation_duplicate",
      "no active claim_submission on case",
      "operator_review_attested = true",
      "draft export exists (export_run_id)",
    ],
  },
  needs_review: {
    when: "warnings.length > 0 AND blockers.length = 0",
    does_not_block_manual_handoff: true,
  },
  blocked: {
    when: "preview.blockers.length > 0 OR case not open OR remediated duplicate OR date_gate failed OR not attested",
  },
  already_submitted: {
    when: "metadata.claim_submission_id present OR active claim_submissions row linked to claim_case_id",
    action: "read-only view; no second active submission",
  },
  duplicate_submission_risk: {
    when: "idempotency_key collision OR second export_run without cancel of prior draft submission record",
    prevention: "UNIQUE (organization_id, claim_case_id) WHERE status NOT IN (cancelled) — proposed",
  },
} as const;

export const DUPLICATE_SUBMISSION_PREVENTION = {
  one_active_per_claim_case: true,
  active_statuses: ["draft", "ready_to_send", "submitted", "investigating", "evidence_requested"],
  terminal_statuses: ["accepted", "rejected", "cancelled"],
  check_before_insert: [
    "SELECT existing active row for claim_case_id",
    "Reject if metadata.claim_submission_id already set on claim_case",
    "Reject if remediated/closed case",
  ],
  idempotency: CLAIM_SUBMISSIONS_USAGE_CONTRACT.idempotency_key_pattern,
  legacy_rows_untouched: "Existing 3 return-linked submissions remain independent of pilot cases",
} as const;

export const NEXT_PHASES = {
  manual_filing_handoff_preview: {
    prompt: "PHASE-CLAIM-MANUAL-FILING-HANDOFF-PREVIEW-V1",
    scope: "Read-only UI panel showing handoff checklist + export links; no INSERT",
    prerequisite: "SAFE_TO_BUILD_MANUAL_FILING_HANDOFF_PREVIEW=yes",
  },
  claim_submissions_record_pilot: {
    prompt: "PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1",
    scope: "Controlled INSERT into claim_submissions for open pilot cases only; NO Amazon API",
    prerequisite: "SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT=yes + operator approval",
  },
  reimbursement_tracking: {
    prompt: "PHASE-CLAIM-REIMBURSEMENT-TRACKING-PILOT-V1",
    scope: "Read-only link submission_id to amazon_reimbursements observed lane",
    prerequisite: "submission record exists with external reference",
  },
} as const;

export type ManualFilingCaseAssessment = {
  claim_case_id: string;
  family_key_v3: string | null;
  readiness_state: ManualFilingReadinessState;
  eligible_for_handoff: boolean;
  blockers: string[];
  warnings: string[];
  already_submitted: boolean;
  duplicate_submission_risk: boolean;
  claim_submission_id: string | null;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaBool(meta: Record<string, unknown>, key: string): boolean {
  return meta[key] === true;
}

export function assessManualFilingCase(args: {
  preview: ClaimFilingPacketPreviewV1;
  caseMetadata?: Record<string, unknown>;
  hasActiveSubmissionRow?: boolean;
}): ManualFilingCaseAssessment {
  const meta = args.caseMetadata ?? {};
  const subId = str(meta.claim_submission_id) || null;
  const alreadySubmitted = !!subId || !!args.hasActiveSubmissionRow;

  const exportEligibility = assessPdfExportEligibility(args.preview);
  const blockers = [...exportEligibility.blockers];
  const warnings = [...exportEligibility.warnings];

  if (metaBool(meta, "remediation_duplicate")) blockers.push("remediated_duplicate");
  if (alreadySubmitted) blockers.push("already_submitted");

  let readiness_state: ManualFilingReadinessState;
  if (alreadySubmitted) {
    readiness_state = "already_submitted";
  } else if (blockers.length > 0) {
    readiness_state = "blocked";
  } else if (warnings.length > 0) {
    readiness_state = "needs_review";
  } else if (args.preview.readiness.ready_for_manual_filing) {
    readiness_state = "ready_for_manual_filing";
  } else {
    readiness_state = "blocked";
    blockers.push("not_ready_for_manual_filing");
  }

  const duplicate_submission_risk = alreadySubmitted;

  return {
    claim_case_id: args.preview.claim_case_id,
    family_key_v3: args.preview.family_key_v3,
    readiness_state,
    eligible_for_handoff:
      readiness_state === "ready_for_manual_filing" || readiness_state === "needs_review",
    blockers: [...new Set(blockers)],
    warnings,
    already_submitted: alreadySubmitted,
    duplicate_submission_risk,
    claim_submission_id: subId,
  };
}

export function summarizeManualFilingAssessments(assessments: ManualFilingCaseAssessment[]): {
  eligible_case_count: number;
  blocked_case_count: number;
  already_submitted_count: number;
  needs_review_count: number;
  ready_count: number;
  warning_counts: Record<string, number>;
  by_readiness_state: Record<string, number>;
} {
  const warning_counts: Record<string, number> = {};
  const by_readiness_state: Record<string, number> = {};
  let eligible = 0;
  let blocked = 0;
  let already = 0;
  let needsReview = 0;
  let ready = 0;

  for (const a of assessments) {
    by_readiness_state[a.readiness_state] = (by_readiness_state[a.readiness_state] ?? 0) + 1;
    if (a.eligible_for_handoff) eligible += 1;
    if (a.readiness_state === "blocked") blocked += 1;
    if (a.already_submitted) already += 1;
    if (a.readiness_state === "needs_review") needsReview += 1;
    if (a.readiness_state === "ready_for_manual_filing") ready += 1;
    for (const w of a.warnings) warning_counts[w] = (warning_counts[w] ?? 0) + 1;
  }

  return {
    eligible_case_count: eligible,
    blocked_case_count: blocked,
    already_submitted_count: already,
    needs_review_count: needsReview,
    ready_count: ready,
    warning_counts,
    by_readiness_state,
  };
}

export const MANUAL_FILING_CONTRACT_MANIFEST = {
  version: CLAIM_SUBMISSION_MANUAL_FILING_CONTRACT_V1_VERSION,
  target_ref: ORIGINAL_REF,
  pilot_case_run_id: PILOT_CASE_RUN_ID,
  intake_run_id: PILOT_INTAKE_RUN_ID,
  submission_modes_contract: SUBMISSION_MODES_CONTRACT,
  claim_submissions_usage_contract: CLAIM_SUBMISSIONS_USAGE_CONTRACT,
  manual_filing_handoff_contract: MANUAL_FILING_HANDOFF_CONTRACT,
  safety_rules: SAFETY_RULES,
  UI_requirements: UI_REQUIREMENTS_NEXT_PHASE,
  readiness_rules: READINESS_RULES,
  duplicate_submission_prevention: DUPLICATE_SUBMISSION_PREVENTION,
  next_phases: NEXT_PHASES,
} as const;
