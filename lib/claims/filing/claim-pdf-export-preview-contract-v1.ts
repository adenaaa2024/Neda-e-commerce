/**
 * PHASE-CLAIM-PDF-EXPORT-PREVIEW-CONTRACT-V1
 * Read-only PDF/export preview planning contract for trusted pilot filing packets.
 * No final PDF generation. No file upload. No claim_submission. No DB writes.
 */
import type { ClaimFilingPacketPreviewV1 } from "./claim-filing-packet-preview-v1";
import {
  MONEY_RULES,
  NARRATIVE_RULES,
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
  ORIGINAL_REF,
  REQUIRED_CASE_FIELDS,
  REQUIRED_LINE_FIELDS,
} from "./claim-filing-packet-v1-plan-contract";

export const CLAIM_PDF_EXPORT_PREVIEW_CONTRACT_V1_VERSION =
  "claim-pdf-export-preview-contract-v1" as const;

export const PDF_EXPORT_CONTRACT = {
  version: CLAIM_PDF_EXPORT_PREVIEW_CONTRACT_V1_VERSION,
  mode: "read-only-planning-contract",
  target_ref: ORIGINAL_REF,
  pilot_case_run_id: PILOT_CASE_RUN_ID,
  intake_run_id: PILOT_INTAKE_RUN_ID,
  anchor: "ClaimFilingPacketPreviewV1 from composeClaimFilingPacketPreviewV1",
  final_pdf_generation: false,
  file_upload: false,
  claim_submission_insert: false,
  amazon_api: false,
  ai_gpt: false,
} as const;

export const EXPORT_PACKAGE_TYPES = {
  html_preview: {
    id: "html_preview",
    label: "HTML preview",
    phase: "V1 — first implement after contract",
    purpose: "Browser/iframe printable draft; reuse evidence-packet HTML patterns",
    persistence: "local audit folder only",
    watermark: true,
  },
  pdf_preview: {
    id: "pdf_preview",
    label: "PDF preview",
    phase: "V1 pilot — local render only (headless or print-to-PDF)",
    purpose: "Operator review packet; DRAFT watermark on every page",
    persistence: "local audit folder only — no Supabase Storage upload",
    watermark: true,
    note: "Not final filing PDF; no Amazon portal upload",
  },
  json_export: {
    id: "json_export",
    label: "JSON export",
    phase: "V1 — machine-readable filing packet snapshot",
    purpose: "Audit trail + downstream tooling; mirrors ClaimFilingPacketPreviewV1",
    persistence: "local audit folder only",
    watermark: false,
    includes_safety_labels: true,
  },
  csv_summary: {
    id: "csv_summary",
    label: "CSV summary",
    phase: "V1 optional — batch operator review",
    purpose: "One row per open pilot case: ids, family, qty, readiness, warning codes",
    persistence: "local audit folder only",
    columns: [
      "claim_case_id",
      "family_key_v3",
      "source_event_key",
      "clean_quantity",
      "ready_for_pdf_preview",
      "ready_for_manual_filing",
      "warning_codes",
      "blocker_codes",
      "export_run_id",
    ],
  },
  manual_filing_bundle: {
    id: "manual_filing_bundle",
    label: "Manual filing packet bundle",
    phase: "deferred — separate operator-approved phase",
    purpose: "ZIP of HTML + JSON + optional PDF preview for manual Amazon filing",
    persistence: "local only until explicit upload approval",
    requires: ["operator_manual_filing_approval", "no_active_submission"],
  },
} as const;

export const PDF_CONTENT_SECTIONS = [
  {
    id: "cover_summary",
    title: "Cover summary",
    fields: [
      "export_run_id",
      "composed_at",
      "pilot_case_run_id",
      "intake_run_id",
      "internal_filing_summary",
      "readiness.ready_for_pdf_preview",
      "readiness.ready_for_manual_filing",
      "warning_count",
      "blocker_count",
    ],
  },
  {
    id: "case_identity",
    title: "Case identity",
    fields: [
      "claim_case_id",
      "case_idempotency_key",
      "case_status",
      "claim_family",
      "claim_source",
      "claim_subtype",
      "family_key_v3",
    ],
  },
  {
    id: "claim_line_summary",
    title: "Claim line summary",
    fields: [
      "line_summary.claim_line_ids",
      "line_summary.candidate_ids",
      "line_summary.quantity_expected",
      "line_summary.line_status",
    ],
  },
  {
    id: "product_identity",
    title: "Product identity",
    fields: [
      "product_identity.asin",
      "product_identity.fnsku",
      "product_identity.sku",
      "product_identity.resolved_product_id",
    ],
  },
  {
    id: "quantity_and_source_event",
    title: "Quantity & source event",
    fields: ["clean_quantity", "source_event_key", "source_event_date"],
  },
  {
    id: "evidence_summary",
    title: "Evidence summary",
    fields: ["evidence_summary", "internal_filing_summary"],
  },
  {
    id: "source_reference_edges",
    title: "Source & reference edges",
    fields: ["source_edges", "reference_edges"],
  },
  {
    id: "date_gate_proof",
    title: "Date gate proof",
    fields: [
      "date_gate.date_gate_passed",
      "date_gate.source_event_date",
      "date_gate.effective_date_source",
      "date_gate.effective_date_value",
    ],
  },
  {
    id: "operator_attestation",
    title: "Operator attestation",
    fields: [
      "operator_attestation.attested",
      "operator_attestation.attested_by",
      "operator_attestation.attested_at",
    ],
  },
  {
    id: "money_lanes",
    title: "Money lanes",
    fields: [
      "money_lanes.estimated_amazon_payout",
      "money_lanes.observed_reimbursement",
      "money_lanes.internal_cost_loss",
      "money_lanes.recovery_value",
      "money_lanes.expected_amount",
      "money_lanes.sale_price_display_only",
      "money_lanes.currency",
    ],
    null_rule: MONEY_RULES.null_rule,
    sale_price_rule: MONEY_RULES.sale_price_rule,
  },
  {
    id: "warnings_blockers",
    title: "Warnings & blockers",
    fields: ["warnings", "blockers"],
  },
  {
    id: "draft_watermark",
    title: "DRAFT watermark / header",
    fields: ["safety_labels", "amazon_facing_draft_text"],
    fixed_header: "DRAFT — NOT SUBMITTED",
  },
] as const;

export const SAFETY_LABELS = {
  draft_only: {
    code: "DRAFT_ONLY",
    display: "DRAFT ONLY",
    placement: ["pdf_header", "pdf_footer", "html_banner", "json.safety_labels[]"],
  },
  not_submitted_amazon: {
    code: "NOT_SUBMITTED_TO_AMAZON",
    display: "NOT SUBMITTED TO AMAZON",
    placement: ["pdf_header", "html_banner", "json.safety_labels[]"],
  },
  internal_review: {
    code: "INTERNAL_REVIEW_PACKET",
    display: "INTERNAL REVIEW PACKET",
    placement: ["pdf_cover", "html_title_suffix", "json.safety_labels[]"],
  },
  no_ai_text: {
    code: "NO_AI_GENERATED_TEXT",
    display: "No AI/GPT generated text — deterministic templates only",
    placement: ["pdf_footer", "json.meta.narrative_source"],
    narrative_source: NARRATIVE_RULES.ai_generation,
  },
  pdf_export_deferred_until_approved: {
    code: "PDF_PREVIEW_NOT_FINAL",
    display: "PDF preview is not a final filing artifact",
    placement: ["operator_ui", "export_manifest"],
  },
} as const;

export const FILE_NAMING_CONTRACT = {
  pattern:
    "claim-filing-{family_key_v3}-{source_event_key_sanitized}-{claim_case_id_short}-{export_run_id}-DRAFT",
  components: {
    claim_case_id: "Full UUID; also use first 8 chars as claim_case_id_short",
    family_key_v3: "e.g. removal_shipment_missing",
    source_event_key: "Sanitized: alphanumeric + hyphen only; max 48 chars",
    export_run_id: "UTC run id e.g. 20260616T080000Z",
    draft_suffix: "Always -DRAFT before extension",
  },
  extensions: {
    html_preview: ".html",
    pdf_preview: ".pdf",
    json_export: ".json",
    csv_summary: ".csv",
    manual_filing_bundle: ".zip",
  },
  examples: [
    "claim-filing-removal_shipment_missing-387003587-05fcce93-20260616T080000Z-DRAFT.pdf",
    "claim-filing-removal_order_discrepancy-RO-12345-01374921-20260616T080000Z-DRAFT.json",
  ],
  collision_rule: "Same run_id + case_id overwrites prior local draft in audit folder only",
} as const;

export const STORAGE_OUTPUT_STRATEGY = {
  phase_v1_output_root: ".cursor/audit-reports/phase-claim-pdf-export-preview-v1/{export_run_id}/",
  per_case_subfolder: "cases/{claim_case_id}/",
  batch_artifacts: ["summary.csv", "manifest.json", "eligible-count.json"],
  supabase_storage: "forbidden until separate operator approval phase",
  claim_submissions_row: "forbidden in this phase",
  retention: "local audit artifacts only; operator may delete folder without DB rollback",
  upload_boundary: "No permanent upload unless PHASE-CLAIM-PDF-EXPORT-UPLOAD-APPROVAL-V1",
} as const;

export const READINESS_RULES = {
  eligible_requires: [
    "status = open (canonical pilot case)",
    "pilot_case_run_id matches pilot-20260615T190000Z",
    "intake_run_id matches a8a892fe-37d5-4d74-9ea2-02af8fd095ce",
    "not remediation_duplicate",
    "readiness.ready_for_pdf_preview = true",
    "readiness.ready_for_manual_filing = true",
    "blockers.length = 0",
    "all REQUIRED_CASE_FIELDS present on preview",
    "all REQUIRED_LINE_FIELDS present on line_summary",
    "evidence_packet_snapshot present",
    "operator_attestation.attested = true",
    "date_gate proof present",
    "no active claim_submission on case metadata",
  ],
  warnings_allowed: [
    "missing_fee",
    "missing_cost",
    "missing_photo_evidence",
    "missing_evidence",
  ],
  blockers_disqualify: [
    "case_not_open",
    "remediated_duplicate",
    "missing_required_field",
    "date_gate_failed",
    "operator_not_attested",
    "active_submission_exists",
    "line_status_not_ready",
  ],
} as const;

export const EXCLUDED_CASES_RULES = {
  default_filter: "status=open",
  exclude_always: [
    "closed remediated duplicate cases (10 retained closed)",
    "cases with metadata.remediation_duplicate = true",
    "cases with rollback_metadata from remediation run",
  ],
  exclude_when_blocked: [
    "preview.blockers.length > 0",
    "preview.readiness.ready_for_pdf_preview = false",
    "active claim_submission attached",
  ],
  visible_but_no_export: "status=closed filter may show remediated cases — export actions disabled",
  pilot_cap: 10,
} as const;

export const FUTURE_DB_WRITE_BOUNDARY = {
  this_phase: "contract only — zero DB writes",
  pdf_pilot_next_phase: {
    name: "PHASE-CLAIM-PDF-EXPORT-PREVIEW-V1 (implement)",
    allowed: ["local HTML/PDF/JSON/CSV files under audit folder"],
    forbidden: [
      "claim_submissions INSERT",
      "claim_cases UPDATE",
      "claim_lines UPDATE",
      "claim_candidates UPDATE",
      "Supabase Storage upload",
      "Amazon SP-API submission",
    ],
  },
  claim_submission_phase: {
    name: "separate future phase — operator approval required",
    requires: [
      "Maysam/operator approval artifact",
      "explicit SAFE_TO_CREATE_CLAIM_SUBMISSION gate",
      "no duplicate submission guard satisfied",
    ],
  },
} as const;

export const ROLLBACK_CLEANUP_RULES = {
  this_phase: "no DB rollback needed — no DB writes",
  local_files: "delete .cursor/audit-reports/phase-claim-pdf-export-preview-v1/{run_id}/ to cleanup",
  no_orphan_db_rows: true,
} as const;

export type PdfExportEligibilityResult = {
  claim_case_id: string;
  eligible: boolean;
  blockers: string[];
  warnings: string[];
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function sanitizeSourceEventKey(key: string | null): string {
  const s = str(key).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
  return s || "unknown-source";
}

export function buildExportFileBaseName(args: {
  preview: Pick<
    ClaimFilingPacketPreviewV1,
    "claim_case_id" | "family_key_v3" | "source_event_key"
  >;
  exportRunId: string;
}): string {
  const shortId = args.preview.claim_case_id.slice(0, 8);
  const family = str(args.preview.family_key_v3) || "unknown-family";
  const source = sanitizeSourceEventKey(args.preview.source_event_key);
  return `claim-filing-${family}-${source}-${shortId}-${args.exportRunId}-DRAFT`;
}

export function assessPdfExportEligibility(
  preview: ClaimFilingPacketPreviewV1,
): PdfExportEligibilityResult {
  const blockers = [...preview.blockers];
  if (preview.case_status !== "open") blockers.push("case_not_open");
  if (!preview.evidence_packet_snapshot) blockers.push("missing_required_field:evidence_packet_snapshot");
  if (!preview.operator_attestation.attested) blockers.push("operator_not_attested");
  if (!preview.readiness.ready_for_pdf_preview) blockers.push("not_ready_for_pdf_preview");
  if (!str(preview.source_event_key)) blockers.push("missing_required_field:source_event_key");
  if (preview.line_summary.candidate_ids.length === 0) {
    blockers.push("missing_required_field:candidate_ids");
  }
  if (preview.line_summary.claim_line_ids.length === 0) {
    blockers.push("missing_required_field:claim_line_ids");
  }

  const uniqueBlockers = [...new Set(blockers)];
  return {
    claim_case_id: preview.claim_case_id,
    eligible: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    warnings: [...preview.warnings],
  };
}

export function buildSamplePdfOutline(preview: ClaimFilingPacketPreviewV1): {
  title: string;
  watermark: string;
  sections: Array<{ id: string; title: string; summary: string }>;
} {
  return {
    title: `Internal Review Packet — ${preview.family_key_v3 ?? "claim"} — ${preview.claim_case_id.slice(0, 8)}`,
    watermark: "DRAFT — NOT SUBMITTED",
    sections: PDF_CONTENT_SECTIONS.map((s) => ({
      id: s.id,
      title: s.title,
      summary:
        s.id === "cover_summary"
          ? preview.internal_filing_summary
          : s.id === "draft_watermark"
            ? SAFETY_LABELS.draft_only.display
            : `See ${s.fields.join(", ")}`,
    })),
  };
}

export type PdfExportJsonShape = {
  contract_version: typeof CLAIM_PDF_EXPORT_PREVIEW_CONTRACT_V1_VERSION;
  export_run_id: string;
  composed_at: string;
  safety_labels: string[];
  meta: {
    narrative_source: "deterministic_template";
    ai_generated: false;
    target_ref: typeof ORIGINAL_REF;
    pilot_case_run_id: typeof PILOT_CASE_RUN_ID;
    intake_run_id: typeof PILOT_INTAKE_RUN_ID;
  };
  filing_packet_preview: ClaimFilingPacketPreviewV1;
  eligibility: PdfExportEligibilityResult;
  file_name_base: string;
};

export function buildSampleJsonExportShape(
  preview: ClaimFilingPacketPreviewV1,
  exportRunId: string,
): PdfExportJsonShape {
  return {
    contract_version: CLAIM_PDF_EXPORT_PREVIEW_CONTRACT_V1_VERSION,
    export_run_id: exportRunId,
    composed_at: new Date().toISOString(),
    safety_labels: [
      SAFETY_LABELS.draft_only.display,
      SAFETY_LABELS.not_submitted_amazon.display,
      SAFETY_LABELS.internal_review.display,
      SAFETY_LABELS.no_ai_text.display,
    ],
    meta: {
      narrative_source: "deterministic_template",
      ai_generated: false,
      target_ref: ORIGINAL_REF,
      pilot_case_run_id: PILOT_CASE_RUN_ID,
      intake_run_id: PILOT_INTAKE_RUN_ID,
    },
    filing_packet_preview: preview,
    eligibility: assessPdfExportEligibility(preview),
    file_name_base: buildExportFileBaseName({ preview, exportRunId }),
  };
}

export function summarizePdfExportEligibility(
  previews: ClaimFilingPacketPreviewV1[],
): {
  eligible_case_count: number;
  blocked_case_count: number;
  warning_counts: Record<string, number>;
} {
  let eligible = 0;
  let blocked = 0;
  const warning_counts: Record<string, number> = {};

  for (const p of previews) {
    const r = assessPdfExportEligibility(p);
    if (r.eligible) eligible += 1;
    else blocked += 1;
    for (const w of r.warnings) {
      warning_counts[w] = (warning_counts[w] ?? 0) + 1;
    }
  }

  return { eligible_case_count: eligible, blocked_case_count: blocked, warning_counts };
}

/** Contract field manifest for audits. */
export const PDF_EXPORT_CONTRACT_MANIFEST = {
  pdf_export_contract: PDF_EXPORT_CONTRACT,
  export_package_types: EXPORT_PACKAGE_TYPES,
  pdf_content_sections: PDF_CONTENT_SECTIONS,
  safety_labels: SAFETY_LABELS,
  file_naming_contract: FILE_NAMING_CONTRACT,
  storage_output_strategy: STORAGE_OUTPUT_STRATEGY,
  readiness_rules: READINESS_RULES,
  excluded_cases_rules: EXCLUDED_CASES_RULES,
  future_db_write_boundary: FUTURE_DB_WRITE_BOUNDARY,
  rollback_cleanup: ROLLBACK_CLEANUP_RULES,
  required_case_fields: [...REQUIRED_CASE_FIELDS],
  required_line_fields: [...REQUIRED_LINE_FIELDS],
} as const;
