/**
 * PHASE-CLAIM-MANUAL-FILING-HANDOFF-PREVIEW-V1
 * Read-only UI contract for Case Review manual filing handoff checklist.
 */
import type { ClaimCaseReviewRow } from "@/lib/claims/pilot/claim-case-review-readmodel";
import {
  DEFAULT_CASE_REVIEW_INTAKE_RUN_ID,
  DEFAULT_PILOT_CASE_RUN_ID,
} from "@/lib/claims/pilot/claim-case-review-ui-contract";
import type { ClaimFilingPacketPreviewV1 } from "../filing/claim-filing-packet-preview-v1";
import {
  isRemediatedDuplicateCase,
  productIdentityLabel,
} from "../filing/claim-filing-packet-ui-contract";
import {
  assessManualFilingCase,
  type ManualFilingReadinessState,
} from "./claim-submission-manual-filing-contract-v1";
import { TRID_REFERENCE_TYPES } from "../contracts/claim-grouping-filters-manual-batch-contract-v1";

export const CLAIM_MANUAL_FILING_HANDOFF_UI_VERSION =
  "claim-manual-filing-handoff-ui-v1" as const;

export const MANUAL_FILING_HANDOFF_SECTION_ID = "case-review-manual-filing-handoff-section" as const;

export const MANUAL_FILING_HANDOFF_BUTTON_LABEL = "Load manual filing handoff" as const;

export const NOT_SUBMITTED_BANNER_TEXT =
  "NOT SUBMITTED TO AMAZON — DRAFT PACKET FOR INTERNAL MANUAL FILING ONLY" as const;

/** Pilot PDF export run from PHASE-CLAIM-PDF-EXPORT-PREVIEW-PILOT-V1. */
export const PILOT_DRAFT_EXPORT_RUN_ID = "20260616T090000Z" as const;

export const PILOT_DRAFT_EXPORT_BASE = `.cursor/audit-reports/phase-claim-pdf-export-preview-pilot-v1/${PILOT_DRAFT_EXPORT_RUN_ID}` as const;

export const TRID_VERIFY_EVIDENCE_PATH =
  ".cursor/audit-reports/phase-claim-trid-reference-graph-final-verify-v1/20260616T110000Z/results.json" as const;

export const MANUAL_FILING_HANDOFF_FIELDS = [
  "claim_case_id",
  "family_key_v3",
  "source_event_key",
  "source_event_date",
  "trid_reference_graph",
  "tracking_removal_references",
  "asin_fnsku_sku",
  "clean_quantity",
  "amazon_facing_draft_summary",
  "evidence_summary",
  "money_warnings",
  "draft_artifact_paths",
  "not_submitted_banner",
  "readiness_state",
] as const;

export const MANUAL_FILING_HANDOFF_CHECKLIST_ITEMS = [
  {
    id: "review_evidence_packet",
    label: "Review evidence packet",
    description: "Confirm evidence snapshot and pointers match the dispute.",
  },
  {
    id: "open_draft_pdf",
    label: "Open draft PDF",
    description: "Open the local DRAFT PDF from the export folder (watermarked, not for submission).",
  },
  {
    id: "copy_source_reference_identifiers",
    label: "Copy source/reference identifiers",
    description: "Copy tracking, removal order/shipment refs, and expected package pointer for Amazon portal.",
  },
  {
    id: "copy_quantity",
    label: "Copy quantity",
    description: "Copy clean quantity into the Amazon claim form.",
  },
  {
    id: "copy_deterministic_summary",
    label: "Copy deterministic summary",
    description: "Paste the deterministic Amazon-facing draft text (not AI-generated).",
  },
  {
    id: "file_manually_in_amazon_portal",
    label: "File manually in Amazon portal",
    description: "Leave Menorix and file on Amazon Seller Central using copied fields.",
  },
  {
    id: "save_amazon_case_id_later",
    label: "Save Amazon Case ID later",
    description: "Record external Amazon case id when submission-record pilot is approved (disabled now).",
  },
] as const;

export const MANUAL_FILING_HANDOFF_DISABLED_ACTIONS = [
  { id: "create_submission", label: "Create claim submission" },
  { id: "mark_as_filed", label: "Mark as filed" },
  { id: "amazon_submit", label: "Submit to Amazon" },
  { id: "upload_evidence", label: "Upload evidence" },
] as const;

export const HANDOFF_READINESS_BADGE_LABELS: Record<ManualFilingReadinessState, string> = {
  ready_for_manual_filing: "Ready for manual filing",
  needs_review: "Needs review",
  blocked: "Blocked",
  already_submitted: "Already submitted",
  duplicate_submission_risk: "Duplicate submission risk",
};

export type HandoffReferenceGraphLine = {
  kind: string;
  value: string;
  source: string;
};

export type DraftArtifactPaths = {
  folder: string;
  base_name: string;
  html: string;
  json: string;
  txt: string;
  pdf: string;
};

const TRID_KINDS = new Set<string>(TRID_REFERENCE_TYPES);

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function isTridKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return TRID_KINDS.has(k) || k.includes("trid");
}

export function buildDraftArtifactPaths(args: {
  claimCaseId: string;
  familyKeyV3: string | null;
  sourceEventKey: string | null;
  exportRunId?: string;
}): DraftArtifactPaths {
  const runId = args.exportRunId ?? PILOT_DRAFT_EXPORT_RUN_ID;
  const shortId = args.claimCaseId.slice(0, 8);
  const fam = args.familyKeyV3 ?? "unknown";
  const key = args.sourceEventKey ?? "unknown";
  const base_name = `claim-filing-${fam}-${key}-${shortId}-${runId}-DRAFT`;
  const folder = `${PILOT_DRAFT_EXPORT_BASE}/cases/${args.claimCaseId}`;
  return {
    folder,
    base_name,
    html: `${folder}/${base_name}.html`,
    json: `${folder}/${base_name}.json`,
    txt: `${folder}/${base_name}.txt`,
    pdf: `${folder}/${base_name}.pdf`,
  };
}

export function buildHandoffReferenceGraph(
  row: ClaimCaseReviewRow,
  preview: ClaimFilingPacketPreviewV1 | null,
): {
  lines: HandoffReferenceGraphLine[];
  trid_reference: string | null;
  tracking_reference: string | null;
  missing_trid_warning: boolean;
} {
  const lines: HandoffReferenceGraphLine[] = [];
  const seen = new Set<string>();

  const push = (kind: string, value: string, source: string) => {
    if (!value) return;
    const key = `${kind}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push({ kind, value, source });
  };

  for (const e of row.reference_edges) {
    push(str(e.reference_kind) || str(e.edge_type) || "edge", str(e.reference_value), "claim_reference_edges");
  }

  if (preview) {
    for (const e of preview.reference_edges) {
      push(str(e.reference_kind) || str(e.edge_type) || "edge", str(e.reference_value), "filing_packet_preview.reference_edges");
    }
    for (const e of preview.source_edges) {
      const o = e as Record<string, unknown>;
      const table = str(o.table) || str(o.source_table);
      const rowId = str(o.row_id) || str(o.source_row_id);
      if (table && rowId) push(table, rowId, "filing_packet_preview.source_edges");
    }
  }

  if (str(row.source_event_key)) {
    push(
      row.family_key_v3 === "removal_shipment_missing" ? "tracking_number" : "source_event_key",
      str(row.source_event_key),
      "claim_case.source_event_key",
    );
  }

  const primaryLine = row.lines[0];
  if (primaryLine?.claim_candidate_id) {
    push("claim_candidate_id", str(primaryLine.claim_candidate_id), "claim_line");
  }

  let tridRef: string | null = null;
  for (const line of lines) {
    if (isTridKind(line.kind) && line.source !== "claim_case.source_event_key") {
      tridRef = line.value;
      break;
    }
  }

  let trackingRef: string | null = null;
  if (row.family_key_v3 === "removal_shipment_missing" && str(row.source_event_key)) {
    trackingRef = str(row.source_event_key);
  }
  for (const line of lines) {
    const k = line.kind.toLowerCase();
    if (k.includes("tracking") || k === "tracking_number") {
      trackingRef = line.value;
      break;
    }
  }

  const missing_trid_warning = !tridRef && (!!trackingRef || !!str(row.source_event_key));

  return {
    lines,
    trid_reference: tridRef,
    tracking_reference: trackingRef,
    missing_trid_warning,
  };
}

export function deriveHandoffReadinessState(
  row: ClaimCaseReviewRow,
  preview: ClaimFilingPacketPreviewV1 | null,
): ManualFilingReadinessState {
  if (!preview || isRemediatedDuplicateCase(row)) return "blocked";
  const assessment = assessManualFilingCase({
    preview,
    caseMetadata: row.metadata ?? {},
    hasActiveSubmissionRow: false,
  });
  return assessment.readiness_state;
}

export function manualFilingHandoffDisabled(row: ClaimCaseReviewRow): boolean {
  return isRemediatedDuplicateCase(row);
}

export function moneyWarningLabels(preview: ClaimFilingPacketPreviewV1 | null): string[] {
  if (!preview) return [];
  return preview.warnings.filter(
    (w) =>
      w.includes("fee") ||
      w.includes("cost") ||
      w.includes("money") ||
      w.includes("photo") ||
      w.includes("evidence"),
  );
}

export function handoffApiParams(args: {
  caseId: string;
  pilotCaseRunId?: string | null;
  intakeRunId?: string | null;
  status?: string | null;
}) {
  return {
    case_id: args.caseId,
    pilot_case_run_id: args.pilotCaseRunId?.trim() || DEFAULT_PILOT_CASE_RUN_ID,
    intake_run_id: args.intakeRunId?.trim() || DEFAULT_CASE_REVIEW_INTAKE_RUN_ID,
    status: args.status?.trim() || "open",
    limit: "100",
  };
}

export function buildHandoffDisplaySnapshot(args: {
  row: ClaimCaseReviewRow;
  preview: ClaimFilingPacketPreviewV1;
}): Record<string, unknown> {
  const refGraph = buildHandoffReferenceGraph(args.row, args.preview);
  const artifacts = buildDraftArtifactPaths({
    claimCaseId: args.preview.claim_case_id,
    familyKeyV3: args.preview.family_key_v3,
    sourceEventKey: args.preview.source_event_key,
  });
  const readiness = deriveHandoffReadinessState(args.row, args.preview);

  return {
    claim_case_id: args.preview.claim_case_id,
    family_key_v3: args.preview.family_key_v3,
    source_event_key: args.preview.source_event_key,
    source_event_date: args.preview.source_event_date,
    trid_reference: refGraph.trid_reference,
    tracking_reference: refGraph.tracking_reference,
    reference_graph_lines: refGraph.lines,
    missing_trid_warning: refGraph.missing_trid_warning,
    product_identity: productIdentityLabel(args.preview.product_identity),
    asin: args.preview.product_identity.asin,
    fnsku: args.preview.product_identity.fnsku,
    sku: args.preview.product_identity.sku,
    clean_quantity: args.preview.clean_quantity,
    amazon_facing_draft_summary: args.preview.amazon_facing_draft_text,
    evidence_summary: args.preview.evidence_summary ?? args.preview.internal_filing_summary,
    money_warnings: moneyWarningLabels(args.preview),
    draft_artifact_paths: artifacts,
    readiness_state: readiness,
    not_submitted_banner: NOT_SUBMITTED_BANNER_TEXT,
  };
}
