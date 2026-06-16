/**
 * PHASE-CLAIM-FILING-PACKET-PLAN-V1 — compose read-only filing packet plans from case review rows.
 */
import type { ClaimCaseReviewRow } from "@/lib/claims/pilot/claim-case-review-readmodel";
import {
  ATTACHMENT_RULES,
  CLAIM_FILING_PACKET_V1_PLAN_VERSION,
  EVIDENCE_REQUIREMENTS,
  NARRATIVE_RULES,
  type ClaimFilingPacketV1Plan,
} from "./claim-filing-packet-v1-plan-contract";

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function productIdLabel(row: ClaimCaseReviewRow): string {
  const parts = [row.asin, row.fnsku, row.sku].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "unlinked";
}

function buildInternalSummary(row: ClaimCaseReviewRow): { summary: string; template_id: string } {
  const fam = row.family_key_v3 ?? row.claim_subtype ?? "unknown";
  const template =
    fam === "removal_order_discrepancy"
      ? NARRATIVE_RULES.templates.removal_order_discrepancy
      : NARRATIVE_RULES.templates.removal_shipment_missing;
  const text = template
    .replace("{source_event_key}", str(row.source_event_key) || "—")
    .replace("{product_ids}", productIdLabel(row))
    .replace("{clean_quantity}", String(row.clean_quantity ?? row.quantity_expected ?? "—"));
  return { summary: text, template_id: fam };
}

function extractSourcePointers(snapshot: Record<string, unknown> | null): {
  expected_packages: unknown;
  amazon_removals: unknown;
  amazon_removal_shipments: unknown;
} {
  const snap = snapshot ?? {};
  const source = metaRecord(snap.source_evidence ?? snap.source_report);
  return {
    expected_packages: source.expected_packages ?? snap.expected_packages ?? null,
    amazon_removals: source.amazon_removals ?? snap.amazon_removals ?? null,
    amazon_removal_shipments: source.amazon_removal_shipments ?? snap.removal_shipments ?? null,
  };
}

function moneyLaneNullWarnings(lanes: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  if (lanes.fee_payout_unavailable === true || lanes.estimated_amazon_payout == null) {
    warnings.push("missing_fee");
  }
  if (lanes.cogs_unavailable === true || lanes.internal_cost_loss == null) {
    warnings.push("missing_cost");
  }
  return warnings;
}

export function planClaimFilingPacketV1(
  row: ClaimCaseReviewRow,
  options: { has_active_submission?: boolean; claim_submission_id?: string | null } = {},
): ClaimFilingPacketV1Plan {
  const meta = row.metadata ?? {};
  const snapshot = row.evidence_packet_snapshot;
  const snapMeta = snapshot ?? {};
  const dateGate = (snapMeta.date_gate as Record<string, unknown> | undefined) ?? null;
  const qty = (snapMeta.quantity as Record<string, unknown> | undefined) ?? null;
  const moneyLanes = { ...row.money_lanes };
  const lanesFromSnap = metaRecord(snapMeta.money_lanes);
  for (const [k, v] of Object.entries(lanesFromSnap)) {
    if (!(k in moneyLanes)) moneyLanes[k] = v;
  }

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (row.status !== "open") blockers.push("case_not_open");
  if (meta.remediation_duplicate === true || row.rollback_metadata) {
    blockers.push("remediated_duplicate");
  }
  if (!row.idempotency_key) blockers.push("missing_required_field:idempotency_key");
  if (row.candidate_ids.length === 0) blockers.push("missing_required_field:candidate_ids");
  if (!snapshot) blockers.push("missing_required_field:evidence_packet_snapshot");
  if (!row.operator_review_attested) blockers.push("operator_not_attested");
  if (!row.date_gate_passed) blockers.push("date_gate_failed");
  if (!str(row.source_event_key)) blockers.push("missing_required_field:source_event_key");
  if (row.lines.length !== 1) blockers.push("missing_required_field:single_claim_line");
  for (const line of row.lines) {
    if (!line.claim_candidate_id) blockers.push("missing_required_field:claim_candidate_id");
    if (!line.idempotency_key) blockers.push("missing_required_field:line_idempotency_key");
    if (line.status !== "claim_ready") blockers.push(`line_status_not_ready:${line.status}`);
  }

  if (options.has_active_submission) blockers.push("active_submission_exists");

  warnings.push(...moneyLaneNullWarnings(moneyLanes));

  const fam = row.family_key_v3 ?? "";
  if (
    (EVIDENCE_REQUIREMENTS.photo_evidence.warning_for_removal_api_families as readonly string[]).includes(
      fam,
    )
  ) {
    const hasPhoto =
      Array.isArray(snapMeta.evidence_pointers) &&
      (snapMeta.evidence_pointers as unknown[]).length > 0;
    if (!hasPhoto) warnings.push("missing_photo_evidence");
    warnings.push("missing_evidence");
  }

  const narrative = buildInternalSummary(row);

  const submissionSafety = {
    excluded_reason:
      row.status !== "open" || meta.remediation_duplicate === true
        ? "closed_or_remediated"
        : options.has_active_submission
          ? "active_submission_exists"
          : null,
    has_active_submission: !!options.has_active_submission,
    claim_submission_id: options.claim_submission_id ?? null,
  };

  const ready = blockers.length === 0;

  return {
    version: CLAIM_FILING_PACKET_V1_PLAN_VERSION,
    composed_at: new Date().toISOString(),
    case_identity: {
      claim_case_id: row.id,
      pilot_case_run_id: row.pilot_case_run_id,
      intake_run_id: row.intake_run_id,
      claim_family: row.claim_family,
      claim_source: row.claim_source,
      claim_subtype: row.claim_subtype,
      family_key_v3: row.family_key_v3,
      status: row.status,
      idempotency_key: row.idempotency_key,
    },
    line_data: {
      candidate_ids: row.candidate_ids,
      claim_line_ids: row.lines.map((l) => l.id),
      product_identifiers: {
        asin: row.asin,
        fnsku: row.fnsku,
        sku: row.sku,
        resolved_product_id: row.resolved_product_id,
      },
      clean_quantity: row.clean_quantity ?? num(qty?.clean_quantity) ?? row.quantity_expected,
      source_event_key: row.source_event_key,
      source_event_date: row.source_event_date,
    },
    evidence: {
      evidence_packet_snapshot: snapshot,
      evidence_summary:
        str(snapMeta.evidence_summary) ||
        str(snapMeta.orbit_evidence_summary) ||
        str(meta.evidence_summary) ||
        null,
      reference_edges: row.reference_edges.map((e) => ({
        id: e.id,
        edge_type: e.edge_type,
        reference_kind: e.reference_kind,
        reference_value: e.reference_value,
      })),
      source_pointers: extractSourcePointers(snapshot),
      date_gate: dateGate,
      operator_attestation: {
        attested: row.operator_review_attested,
        attested_by: row.operator_review_attested_by,
        attested_at: row.operator_review_attested_at,
      },
    },
    money: {
      estimated_amount: num(moneyLanes.estimated_amazon_payout ?? moneyLanes.expected_amount),
      recovery_value: num(moneyLanes.recovery_value),
      observed_reimbursement: num(moneyLanes.observed_reimbursement),
      internal_cost_loss: num(moneyLanes.internal_cost_loss),
      money_lanes: moneyLanes,
      null_preservation: true,
    },
    narrative: {
      internal_filing_summary: narrative.summary,
      amazon_facing_draft_text: `[DRAFT — NOT FOR SUBMISSION] ${narrative.summary}`,
      template_id: narrative.template_id,
      ai_generated: false,
    },
    attachments: {
      pdf_export_deferred: true,
      photo_evidence_required: false,
      photo_evidence_warning: warnings.includes("missing_photo_evidence"),
    },
    readiness: {
      ready_for_filing_packet: ready,
      blockers,
      warnings: [...new Set(warnings)],
    },
    submission_safety: submissionSafety,
  };
}

export function summarizeFilingPacketPlans(plans: ClaimFilingPacketV1Plan[]): {
  eligible_case_count: number;
  blocked_case_count: number;
  warning_counts: Record<string, number>;
} {
  let eligible = 0;
  let blocked = 0;
  const warning_counts: Record<string, number> = {};

  for (const p of plans) {
    if (p.readiness.ready_for_filing_packet) eligible += 1;
    else blocked += 1;
    for (const w of p.readiness.warnings) {
      warning_counts[w] = (warning_counts[w] ?? 0) + 1;
    }
  }

  return { eligible_case_count: eligible, blocked_case_count: blocked, warning_counts };
}
