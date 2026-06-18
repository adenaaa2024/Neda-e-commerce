/**
 * PHASE-CLAIM-SELLER-CENTRAL-FILING-PACKET-V1
 *
 * Read-only composer that produces ONE manual Seller Central filing packet per
 * claim_submission_id for the 10 pilot submissions, or recommends grouped filing
 * where references are SAFELY shared. Pure read-model composition over existing
 * read-models — no DB writes, no claim_* mutation, no Amazon, no browser automation,
 * no AI/GPT.
 *
 * Hard rules (by construction):
 *  - Never invent missing identifiers (only surfaces what the read-models resolved).
 *  - Never use simulated case IDs (record-back fields are empty placeholders).
 *  - Claim amount = recovery_value = clean_quantity x approved_cogs_unit (never sale price).
 *  - If a required reference is missing, the packet is marked NOT ready (blocked).
 *  - Subjects/bodies are deterministic templates with cited source facts and are
 *    flagged human_review_required — MENORIX does not submit to Amazon.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "./claim-filing-packet-v1-plan-contract";
import { PILOT_OUTPUT_ROOT } from "./claim-filing-packet-export-paths";
import {
  composeClaimFilingPacketPreviewV1,
  type ClaimFilingPacketPreviewV1,
} from "./claim-filing-packet-preview-v1";
import { composeMoneyLanePreviewAfterCogsV1 } from "../submission/claim-money-lane-preview-after-cogs-v1";
import { composeReimbursementTrackingPreviewV1 } from "../submission/claim-reimbursement-tracking-preview-v1";
import {
  composeTridReferenceTraceMatrixV1,
  type PerSubmissionReferenceTrace,
} from "../reference/trid-reference-trace-matrix-v1";

export const CLAIM_SELLER_CENTRAL_FILING_PACKET_V1 =
  "claim-seller-central-filing-packet-v1" as const;

export const SELLER_CENTRAL_HUMAN_REVIEW_REQUIRED = true as const;

/** Deterministic subject templates per claim family. */
export const SELLER_CENTRAL_SUBJECT_TEMPLATES = {
  removal_shipment_missing:
    "FBA reimbursement request — removal shipment missing / not delivered — {fnsku} (qty {qty})",
  removal_order_discrepancy:
    "FBA reimbursement request — removal order quantity discrepancy — {fnsku} (qty {qty})",
  default: "FBA reimbursement request — {family} — {fnsku} (qty {qty})",
} as const;

export const SELLER_CENTRAL_DRAFT_LABEL =
  "[DRAFT — HUMAN REVIEW REQUIRED — MENORIX DID NOT CONTACT AMAZON]" as const;

type RunOpts = { pilot_case_run_id?: string; intake_run_id?: string };

function str(v: unknown): string {
  return String(v ?? "").trim();
}

/** Internal DB UUID — must NOT be surfaced as an Amazon-facing reference (TRID/order id). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pick the first REAL external/source reference from a candidate list, skipping
 * internal DB UUID surrogates (e.g. amazon_removals.id used as a pointer). Returns
 * null when only internal UUIDs are present — callers must not fall back to a UUID.
 */
function pickExternalReference(values: readonly (string | null | undefined)[]): string | null {
  for (const v of values) {
    const s = str(v);
    if (s && !UUID_RE.test(s)) return s;
  }
  return null;
}

function money(v: number | null): string {
  return v == null ? "—" : `$${v.toFixed(2)}`;
}

export type SellerCentralRecordBackFields = {
  amazon_case_id: string | null;
  filed_at: string | null;
  filed_by: string | null;
  external_case_url: string | null;
  notes: string | null;
};

export type SellerCentralCopyIntoFields = {
  subject: string;
  message_body: string;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  removal_order_id: string | null;
  removal_shipment_id: string | null;
  quantity_affected: number | null;
  requested_reimbursement_amount: number | null;
  currency: string;
};

export type SellerCentralFilingPacket = {
  claim_submission_id: string;
  claim_case_id: string | null;
  claim_family: string | null;

  recommended_filing_group_id: string;
  file_individually: boolean;
  grouping_reason: string;

  seller_central_case_subject: string;
  seller_central_message_body: string;

  requested_reimbursement_amount: number | null;
  quantity_affected: number | null;
  approved_cogs_unit: number | null;
  recovery_formula: string;

  fnsku: string | null;
  sku: string | null;
  asin: string | null;

  trid: string | null;
  expected_package_id: string | null;
  product_link_resolved_product_id: string | null;

  removal_order_id: string | null;
  removal_shipment_id: string | null;

  source_table: string | null;
  source_row_ids: {
    claim_candidate_id: string | null;
    claim_line_ids: string[];
    source_row_id: string | null;
  };

  evidence_packet_path: string;
  attachments_to_include: string[];

  human_review_checklist: string[];
  fields_to_copy_into_seller_central: SellerCentralCopyIntoFields;
  fields_to_record_back: SellerCentralRecordBackFields;

  ready_to_file: boolean;
  blockers: string[];
  human_review_required: true;
};

export type SellerCentralFilingGroup = {
  filing_group_id: string;
  group_basis: "individual" | "shared_removal_order_id" | "shared_removal_shipment_id";
  shared_reference_value: string | null;
  claim_submission_ids: string[];
  claim_case_ids: string[];
  recommendation: "file_individually" | "file_grouped";
  reason: string;
};

export type SellerCentralFilingPacketResult = {
  version: typeof CLAIM_SELLER_CENTRAL_FILING_PACKET_V1;
  pilot_case_run_id: string;
  intake_run_id: string;
  read_only: true;
  does_not_submit: true;
  ai_generated_text: false;
  human_review_required: true;

  filing_packet_count: number;
  ready_to_file_count: number;
  blocked_packet_count: number;

  filing_group_matrix: SellerCentralFilingGroup[];
  per_submission_filing_packet: SellerCentralFilingPacket[];
  amazon_subjects: Array<{ claim_submission_id: string; subject: string }>;
  amazon_message_bodies: Array<{ claim_submission_id: string; body: string }>;
  evidence_attachment_matrix: Array<{
    claim_submission_id: string;
    evidence_packet_path: string;
    attachments: string[];
  }>;

  prerequisites: {
    SAFE_MONEY_LANE_PREVIEW_READY: boolean;
    cogs_coverage_count: number;
    recovery_value_coverage: string;
    trid_coverage_count: string;
    reference_edges_total: number;
  };
};

function subjectFor(family: string | null, fnsku: string | null, qty: number | null): string {
  const key =
    family === "removal_shipment_missing"
      ? "removal_shipment_missing"
      : family === "removal_order_discrepancy"
        ? "removal_order_discrepancy"
        : "default";
  return SELLER_CENTRAL_SUBJECT_TEMPLATES[key]
    .replace("{fnsku}", fnsku ?? "unknown-FNSKU")
    .replace("{qty}", qty == null ? "—" : String(qty))
    .replace("{family}", family ?? "FBA discrepancy");
}

function messageBodyFor(args: {
  family: string | null;
  fnsku: string | null;
  sku: string | null;
  asin: string | null;
  quantity: number | null;
  recoveryValue: number | null;
  approvedCogsUnit: number | null;
  removalOrderId: string | null;
  removalShipmentId: string | null;
  expectedPackageId: string | null;
  trackingNumber: string | null;
  sourceEventKey: string | null;
  evidenceSummary: string | null;
}): string {
  const lines: string[] = [];
  lines.push(SELLER_CENTRAL_DRAFT_LABEL);
  lines.push("");
  lines.push("Hello Seller Support,");
  lines.push("");

  const familyClause =
    args.family === "removal_order_discrepancy"
      ? "We are requesting reimbursement for a removal order quantity discrepancy — units were not returned or accounted for after the removal order was processed."
      : "We are requesting reimbursement for a removal shipment that was lost or not delivered — units left the fulfillment center but were not received.";
  lines.push(familyClause);
  lines.push("");

  lines.push("Item / identifiers:");
  if (args.asin) lines.push(`- ASIN: ${args.asin}`);
  if (args.fnsku) lines.push(`- FNSKU: ${args.fnsku}`);
  if (args.sku) lines.push(`- SKU: ${args.sku}`);
    // Only REAL external/source references belong in the Amazon-facing body —
    // never an internal DB UUID surrogate (the expected_package_id / row pointers
    // stay in the internal anchors section, not in Seller Central proof).
    if (args.removalOrderId && !UUID_RE.test(args.removalOrderId)) {
      lines.push(`- Removal Order ID: ${args.removalOrderId}`);
    }
    if (args.removalShipmentId && !UUID_RE.test(args.removalShipmentId)) {
      lines.push(`- Removal Shipment ID: ${args.removalShipmentId}`);
    }
    if (args.trackingNumber && !UUID_RE.test(args.trackingNumber)) {
      lines.push(`- Tracking / shipment reference: ${args.trackingNumber}`);
    }
    if (args.sourceEventKey && !UUID_RE.test(args.sourceEventKey)) {
      lines.push(`- Source event reference: ${args.sourceEventKey}`);
    }
  lines.push("");

  lines.push(`Quantity affected: ${args.quantity == null ? "—" : args.quantity}`);
  lines.push(
    `Requested reimbursement: ${money(args.recoveryValue)} (= clean quantity ${
      args.quantity ?? "—"
    } x approved cost/unit ${money(args.approvedCogsUnit)}).`,
  );
  lines.push("");

  if (args.evidenceSummary) {
    lines.push("Supporting evidence:");
    lines.push(`- ${args.evidenceSummary}`);
    lines.push("");
  }

  lines.push(
    "Removal order and shipment records, plus the expected-package reconciliation, are attached for verification. Please review and process the reimbursement for the affected units.",
  );
  lines.push("");
  lines.push("Thank you.");
  return lines.join("\n");
}

function humanReviewChecklist(args: {
  ready: boolean;
  blockers: string[];
}): string[] {
  const list = [
    "Confirm the product identity (ASIN / FNSKU / SKU) matches the Seller Central inventory record.",
    "Confirm the quantity affected against the removal order / shipment in Seller Central.",
    "Confirm the requested amount uses approved COGS/unit (NOT the sale/list price).",
    "Confirm the removal_order_id / removal_shipment_id / tracking reference exist in your Amazon reports.",
    "Attach the evidence packet (removal + shipment + expected-package records) before submitting.",
    "Review and edit the draft subject/body wording — it is a deterministic draft, not final copy.",
    "File manually in Seller Central; MENORIX will NOT submit on your behalf.",
    "After Amazon creates the case, record amazon_case_id + filed_at + filed_by back into MENORIX.",
  ];
  if (!args.ready) {
    list.unshift(
      `DO NOT FILE YET — packet is blocked: ${args.blockers.join(", ") || "missing required data"}.`,
    );
  }
  return list;
}

function evidencePath(args: {
  exportArtifactPaths: Record<string, unknown> | null;
  claimCaseId: string | null;
}): string {
  const paths = args.exportArtifactPaths ?? {};
  for (const key of ["pdf", "html", "json", "txt", "case_dir"]) {
    const v = str((paths as Record<string, unknown>)[key]);
    if (v) return v;
  }
  // Deterministic local draft export location (PHASE-CLAIM-PDF-EXPORT-PREVIEW-PILOT-V1).
  return `${PILOT_OUTPUT_ROOT}/<latest-run>/${args.claimCaseId ?? "case"}/ (local draft export — regenerate before filing)`;
}

function attachmentsFor(args: {
  trace: PerSubmissionReferenceTrace | null;
  preview: ClaimFilingPacketPreviewV1 | null;
}): string[] {
  const out: string[] = [];
  if (args.trace?.removal_order_ids.length) {
    out.push(`amazon_removals record(s): ${args.trace.removal_order_ids.join(", ")}`);
  }
  if (args.trace?.removal_shipment_ids.length) {
    out.push(`amazon_removal_shipments record(s): ${args.trace.removal_shipment_ids.join(", ")}`);
  }
  if (args.trace?.expected_package_id) {
    out.push(`expected_packages reconciliation: ${args.trace.expected_package_id}`);
  }
  if (args.trace?.tracking_numbers.length) {
    out.push(`tracking/shipment reference: ${args.trace.tracking_numbers.join(", ")}`);
  }
  out.push("Filing packet PDF (local draft export — NOT submitted to Amazon)");
  if (args.preview?.evidence_summary) out.push("Evidence summary snapshot");
  out.push("Photo evidence: optional for removal/API families (warning only, not required)");
  return out;
}

export async function composeClaimSellerCentralFilingPacketV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  opts: RunOpts = {},
): Promise<SellerCentralFilingPacketResult> {
  const pilotCaseRunId = opts.pilot_case_run_id ?? PILOT_CASE_RUN_ID;
  const intakeRunId = opts.intake_run_id ?? PILOT_INTAKE_RUN_ID;
  const runOpts = { pilot_case_run_id: pilotCaseRunId, intake_run_id: intakeRunId };

  const [money_, tracking, trace, packetPreview] = await Promise.all([
    composeMoneyLanePreviewAfterCogsV1(client, organizationId, storeId, runOpts),
    composeReimbursementTrackingPreviewV1(client, organizationId, storeId, runOpts),
    composeTridReferenceTraceMatrixV1(client, organizationId, storeId, runOpts),
    composeClaimFilingPacketPreviewV1(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
      status: "open",
      limit: 100,
    }),
  ]);

  const moneyBySubmission = new Map(
    money_.per_submission_money_matrix.map((r) => [r.claim_submission_id, r]),
  );
  const traceBySubmission = new Map(
    trace.per_submission_reference_matrix.map((r) => [r.claim_submission_id, r]),
  );
  const trackingBySubmission = new Map(
    tracking.previews.map((r) => [r.claim_submission_id, r]),
  );
  const previewByCase = new Map(packetPreview.previews.map((p) => [p.claim_case_id, p]));

  // ---- Grouping analysis: recommend grouped only where a removal_order_id (or
  //      removal_shipment_id) is shared by >1 submission with consistent product. ----
  const removalOrderToSubs = new Map<string, Set<string>>();
  const removalShipmentToSubs = new Map<string, Set<string>>();
  for (const t of trace.per_submission_reference_matrix) {
    for (const ro of t.removal_order_ids) {
      const set = removalOrderToSubs.get(ro) ?? new Set<string>();
      set.add(t.claim_submission_id);
      removalOrderToSubs.set(ro, set);
    }
    for (const rs of t.removal_shipment_ids) {
      const set = removalShipmentToSubs.get(rs) ?? new Set<string>();
      set.add(t.claim_submission_id);
      removalShipmentToSubs.set(rs, set);
    }
  }

  const sharedRemovalOrder = (subId: string): string | null => {
    const t = traceBySubmission.get(subId);
    if (!t) return null;
    for (const ro of t.removal_order_ids) {
      if ((removalOrderToSubs.get(ro)?.size ?? 0) > 1) return ro;
    }
    return null;
  };

  const packets: SellerCentralFilingPacket[] = [];

  for (const row of tracking.previews) {
    const subId = row.claim_submission_id;
    const m = moneyBySubmission.get(subId) ?? null;
    const t = traceBySubmission.get(subId) ?? null;
    const preview = row.claim_case_id ? previewByCase.get(row.claim_case_id) ?? null : null;

    const family = m?.family ?? t?.claim_family ?? row.family_key_v3 ?? row.claim_family ?? null;
    const fnsku = m?.fnsku ?? t?.fnsku ?? row.fnsku ?? null;
    const sku = m?.sku ?? t?.sku ?? row.sku ?? null;
    const asin = t?.asin ?? row.asin ?? null;
    const quantity = m?.clean_quantity ?? t?.quantity ?? row.clean_quantity ?? null;
    const approvedCogsUnit = m?.approved_cogs_unit ?? null;
    const recoveryValue = m?.recovery_value ?? row.recovery_value ?? null;

    const trid = t?.primary_trid ?? null;
    const expectedPackageId = t?.expected_package_id ?? null;
    const resolvedProductId = t?.resolved_product_id ?? null;
    // Prefer a REAL external removal order id (e.g. "1621GIL") over an internal
    // amazon_removals.id UUID surrogate that the discrepancy family edges carry.
    const removalOrderId = pickExternalReference(t?.removal_order_ids ?? []);
    const removalShipmentId = t?.removal_shipment_ids[0] ?? null;
    const trackingNumber = pickExternalReference(t?.tracking_numbers ?? []);

    // ---- Readiness: required references + money present, nothing missing ----
    const blockers: string[] = [];
    if (recoveryValue == null) blockers.push("missing_recovery_value");
    if (recoveryValue != null && recoveryValue <= 0) blockers.push("non_positive_recovery_value");
    if (approvedCogsUnit == null) blockers.push("missing_approved_cogs_unit");
    if (quantity == null) blockers.push("missing_clean_quantity");
    if (!fnsku) blockers.push("missing_fnsku");
    if (!trid && !expectedPackageId && !resolvedProductId) blockers.push("missing_primary_trid");
    if ((t?.reference_edge_count ?? 0) === 0) blockers.push("missing_reference_edges");
    if ((t?.missing_refs.length ?? 0) > 0) {
      blockers.push(`missing_reference:${t?.missing_refs.join("|")}`);
    }
    if ((t?.ambiguous_matches.length ?? 0) > 0) blockers.push("ambiguous_reference_present");
    if (str(row.future_amazon_case_id)) blockers.push("amazon_case_id_already_recorded");
    if (!preview?.evidence_packet_snapshot && !preview?.evidence_summary) {
      blockers.push("missing_evidence_packet");
    }
    for (const b of row.detail_preview.blockers) blockers.push(`submission_blocker:${b}`);

    const ready = blockers.length === 0;

    const sharedRo = sharedRemovalOrder(subId);
    const fileIndividually = sharedRo == null;
    const recommendedGroupId = fileIndividually ? subId : `group:removal_order:${sharedRo}`;
    const groupingReason = fileIndividually
      ? "References (removal order / shipment / expected package) are unique to this submission — file individually."
      : `Shares removal_order_id ${sharedRo} with other pilot submission(s) — grouped filing is reference-safe.`;

    const subject = subjectFor(family, fnsku, quantity);
    const body = messageBodyFor({
      family,
      fnsku,
      sku,
      asin,
      quantity,
      recoveryValue,
      approvedCogsUnit,
      removalOrderId,
      removalShipmentId,
      expectedPackageId,
      trackingNumber,
      sourceEventKey: row.source_event_key ?? t?.source_table ?? null,
      evidenceSummary: preview?.evidence_summary ?? null,
    });

    const recoveryFormula =
      recoveryValue != null && quantity != null && approvedCogsUnit != null
        ? `recovery_value = clean_quantity (${quantity}) x approved_cogs_unit (${money(
            approvedCogsUnit,
          )}) = ${money(recoveryValue)}`
        : "recovery_value = clean_quantity x approved_cogs_unit (incomplete — missing input)";

    const evidence_packet_path = evidencePath({
      exportArtifactPaths: row.export_artifact_paths,
      claimCaseId: row.claim_case_id,
    });
    const attachments = attachmentsFor({ trace: t, preview });

    const currency = str((row.money_lanes as Record<string, unknown>).currency) || "USD";

    packets.push({
      claim_submission_id: subId,
      claim_case_id: row.claim_case_id || null,
      claim_family: family,
      recommended_filing_group_id: recommendedGroupId,
      file_individually: fileIndividually,
      grouping_reason: groupingReason,
      seller_central_case_subject: subject,
      seller_central_message_body: body,
      requested_reimbursement_amount: recoveryValue,
      quantity_affected: quantity,
      approved_cogs_unit: approvedCogsUnit,
      recovery_formula: recoveryFormula,
      fnsku,
      sku,
      asin,
      trid,
      expected_package_id: expectedPackageId,
      product_link_resolved_product_id: resolvedProductId,
      removal_order_id: removalOrderId,
      removal_shipment_id: removalShipmentId,
      source_table: t?.source_table ?? null,
      source_row_ids: {
        claim_candidate_id: t?.source_candidate_id ?? null,
        claim_line_ids: row.claim_lines.map((l) => l.claim_line_id),
        source_row_id: t?.source_row_id ?? null,
      },
      evidence_packet_path,
      attachments_to_include: attachments,
      human_review_checklist: humanReviewChecklist({ ready, blockers }),
      fields_to_copy_into_seller_central: {
        subject,
        message_body: body,
        asin,
        fnsku,
        sku,
        removal_order_id: removalOrderId,
        removal_shipment_id: removalShipmentId,
        quantity_affected: quantity,
        requested_reimbursement_amount: recoveryValue,
        currency,
      },
      fields_to_record_back: {
        amazon_case_id: null,
        filed_at: null,
        filed_by: null,
        external_case_url: null,
        notes: null,
      },
      ready_to_file: ready,
      blockers,
      human_review_required: true,
    });
  }

  // ---- Filing group matrix ----
  const filing_group_matrix: SellerCentralFilingGroup[] = [];
  const groupedSubs = new Set<string>();
  for (const [ro, subs] of removalOrderToSubs.entries()) {
    if (subs.size <= 1) continue;
    const ids = [...subs];
    const caseIds = ids
      .map((s) => trackingBySubmission.get(s)?.claim_case_id ?? null)
      .filter((c): c is string => Boolean(c));
    for (const s of ids) groupedSubs.add(s);
    filing_group_matrix.push({
      filing_group_id: `group:removal_order:${ro}`,
      group_basis: "shared_removal_order_id",
      shared_reference_value: ro,
      claim_submission_ids: ids,
      claim_case_ids: caseIds,
      recommendation: "file_grouped",
      reason: `Removal order ${ro} is shared by ${ids.length} submissions — reference-safe to file as one grouped case.`,
    });
  }
  for (const p of packets) {
    if (groupedSubs.has(p.claim_submission_id)) continue;
    filing_group_matrix.push({
      filing_group_id: p.claim_submission_id,
      group_basis: "individual",
      shared_reference_value: null,
      claim_submission_ids: [p.claim_submission_id],
      claim_case_ids: p.claim_case_id ? [p.claim_case_id] : [],
      recommendation: "file_individually",
      reason: p.grouping_reason,
    });
  }

  const ready = packets.filter((p) => p.ready_to_file);

  return {
    version: CLAIM_SELLER_CENTRAL_FILING_PACKET_V1,
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    read_only: true,
    does_not_submit: true,
    ai_generated_text: false,
    human_review_required: true,
    filing_packet_count: packets.length,
    ready_to_file_count: ready.length,
    blocked_packet_count: packets.length - ready.length,
    filing_group_matrix,
    per_submission_filing_packet: packets,
    amazon_subjects: packets.map((p) => ({
      claim_submission_id: p.claim_submission_id,
      subject: p.seller_central_case_subject,
    })),
    amazon_message_bodies: packets.map((p) => ({
      claim_submission_id: p.claim_submission_id,
      body: p.seller_central_message_body,
    })),
    evidence_attachment_matrix: packets.map((p) => ({
      claim_submission_id: p.claim_submission_id,
      evidence_packet_path: p.evidence_packet_path,
      attachments: p.attachments_to_include,
    })),
    prerequisites: {
      SAFE_MONEY_LANE_PREVIEW_READY: money_.SAFE_MONEY_LANE_PREVIEW_READY,
      cogs_coverage_count: money_.cogs_coverage_count,
      recovery_value_coverage: money_.recovery_value_coverage,
      trid_coverage_count: trace.trid_coverage_count,
      reference_edges_total: trace.total_reference_edges,
    },
  };
}
