/**
 * PHASE-CLAIM-FILING-PACKET-PREVIEW-V1
 * Read-only filing packet preview composer for trusted pilot claim_cases.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildClaimCaseReviewReadmodel,
  type ClaimCaseReviewRow,
} from "@/lib/claims/pilot/claim-case-review-readmodel";
import {
  CLAIM_FILING_PACKET_V1_PLAN_VERSION,
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "./claim-filing-packet-v1-plan-contract";
import { planClaimFilingPacketV1 } from "./claim-filing-packet-v1-plan";

export const CLAIM_FILING_PACKET_PREVIEW_V1_VERSION =
  "claim-filing-packet-preview-v1" as const;

export type ClaimFilingPacketPreviewLineSummary = {
  claim_line_ids: string[];
  candidate_ids: string[];
  quantity_expected: number | null;
  line_status: string | null;
};

export type ClaimFilingPacketPreviewProductIdentity = {
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  resolved_product_id: string | null;
};

export type ClaimFilingPacketPreviewReadiness = {
  ready_for_pdf_preview: boolean;
  ready_for_manual_filing: boolean;
  blockers: string[];
};

export type ClaimFilingPacketPreviewV1 = {
  filing_packet_preview_id: string;
  claim_case_id: string;
  pilot_case_run_id: string | null;
  intake_run_id: string | null;
  claim_family: string | null;
  claim_source: string | null;
  claim_subtype: string | null;
  family_key_v3: string | null;
  case_status: string | null;
  case_idempotency_key: string | null;
  line_summary: ClaimFilingPacketPreviewLineSummary;
  product_identity: ClaimFilingPacketPreviewProductIdentity;
  source_event_key: string | null;
  source_event_date: string | null;
  clean_quantity: number | null;
  evidence_packet_snapshot: Record<string, unknown> | null;
  evidence_summary: string | null;
  source_edges: Array<Record<string, unknown>>;
  reference_edges: Array<{
    id: string;
    edge_type: string | null;
    reference_kind: string | null;
    reference_value: string | null;
  }>;
  date_gate: Record<string, unknown> | null;
  operator_attestation: {
    attested: boolean;
    attested_by: string | null;
    attested_at: string | null;
  };
  money_lanes: Record<string, unknown>;
  internal_filing_summary: string;
  amazon_facing_draft_text: string;
  warnings: string[];
  blockers: string[];
  readiness: ClaimFilingPacketPreviewReadiness;
  pdf_export_deferred: true;
  does_not_submit: true;
};

export type ClaimFilingPacketPreviewQuery = {
  pilot_case_run_id?: string | null;
  intake_run_id?: string | null;
  case_id?: string | null;
  status?: string | null;
  limit?: number;
};

export type ClaimFilingPacketPreviewPayload = {
  version: typeof CLAIM_FILING_PACKET_PREVIEW_V1_VERSION;
  plan_version: typeof CLAIM_FILING_PACKET_V1_PLAN_VERSION;
  composed_at: string;
  read_only: true;
  pilot_case_run_id: string;
  intake_run_id: string;
  default_status_filter: string;
  previews: ClaimFilingPacketPreviewV1[];
  summary: {
    active_cases_loaded: number;
    closed_duplicates_excluded_note: string;
    by_family_key_v3: Record<string, number>;
    ready_for_pdf_preview_count: number;
    ready_for_manual_filing_count: number;
    blocker_counts: Record<string, number>;
    warning_counts: Record<string, number>;
  };
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function extractSourceEdges(snapshot: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (!snapshot) return [];
  const pointers = snapshot.evidence_pointers;
  if (Array.isArray(pointers)) {
    return pointers.filter((p) => p && typeof p === "object") as Array<Record<string, unknown>>;
  }
  const graph = snapshot.reference_graph;
  if (graph && typeof graph === "object" && Array.isArray((graph as { edges?: unknown }).edges)) {
    return ((graph as { edges: unknown[] }).edges ?? []).filter(
      (e) => e && typeof e === "object",
    ) as Array<Record<string, unknown>>;
  }
  return [];
}

export function mapCaseRowToFilingPacketPreviewV1(row: ClaimCaseReviewRow): ClaimFilingPacketPreviewV1 {
  const meta = row.metadata ?? {};
  const subId = str(meta.claim_submission_id) || null;
  const plan = planClaimFilingPacketV1(row, {
    has_active_submission: !!subId,
    claim_submission_id: subId,
  });

  const primaryLine = row.lines[0];
  const noBlockers = plan.readiness.blockers.length === 0;

  return {
    filing_packet_preview_id: randomUUID(),
    claim_case_id: row.id,
    pilot_case_run_id: row.pilot_case_run_id,
    intake_run_id: row.intake_run_id,
    claim_family: row.claim_family,
    claim_source: row.claim_source,
    claim_subtype: row.claim_subtype,
    family_key_v3: row.family_key_v3,
    case_status: row.status,
    case_idempotency_key: row.idempotency_key,
    line_summary: {
      claim_line_ids: plan.line_data.claim_line_ids,
      candidate_ids: plan.line_data.candidate_ids,
      quantity_expected: primaryLine?.quantity_expected ?? null,
      line_status: primaryLine?.status ?? null,
    },
    product_identity: plan.line_data.product_identifiers,
    source_event_key: row.source_event_key,
    source_event_date: row.source_event_date,
    clean_quantity: plan.line_data.clean_quantity,
    evidence_packet_snapshot: plan.evidence.evidence_packet_snapshot,
    evidence_summary: plan.evidence.evidence_summary,
    source_edges: extractSourceEdges(plan.evidence.evidence_packet_snapshot),
    reference_edges: plan.evidence.reference_edges,
    date_gate: plan.evidence.date_gate,
    operator_attestation: plan.evidence.operator_attestation,
    money_lanes: plan.money.money_lanes,
    internal_filing_summary: plan.narrative.internal_filing_summary,
    amazon_facing_draft_text: plan.narrative.amazon_facing_draft_text,
    warnings: plan.readiness.warnings,
    blockers: plan.readiness.blockers,
    readiness: {
      ready_for_pdf_preview: noBlockers,
      ready_for_manual_filing: noBlockers,
      blockers: plan.readiness.blockers,
    },
    pdf_export_deferred: true,
    does_not_submit: true,
  };
}

export function summarizeFilingPacketPreviews(previews: ClaimFilingPacketPreviewV1[]): {
  by_family_key_v3: Record<string, number>;
  ready_for_pdf_preview_count: number;
  ready_for_manual_filing_count: number;
  blocker_counts: Record<string, number>;
  warning_counts: Record<string, number>;
} {
  const by_family_key_v3: Record<string, number> = {};
  let readyPdf = 0;
  let readyManual = 0;
  const blocker_counts: Record<string, number> = {};
  const warning_counts: Record<string, number> = {};

  for (const p of previews) {
    const fam = p.family_key_v3 ?? "unknown";
    by_family_key_v3[fam] = (by_family_key_v3[fam] ?? 0) + 1;
    if (p.readiness.ready_for_pdf_preview) readyPdf += 1;
    if (p.readiness.ready_for_manual_filing) readyManual += 1;
    for (const b of p.blockers) blocker_counts[b] = (blocker_counts[b] ?? 0) + 1;
    for (const w of p.warnings) warning_counts[w] = (warning_counts[w] ?? 0) + 1;
  }

  return {
    by_family_key_v3,
    ready_for_pdf_preview_count: readyPdf,
    ready_for_manual_filing_count: readyManual,
    blocker_counts,
    warning_counts,
  };
}

export function verifyMoneyNullPreservationPreview(
  previews: ClaimFilingPacketPreviewV1[],
): { pass: boolean; coerced_non_null: number } {
  let coerced = 0;
  for (const p of previews) {
    const lanes = p.money_lanes;
    for (const key of [
      "estimated_amazon_payout",
      "observed_reimbursement",
      "internal_cost_loss",
      "recovery_value",
      "expected_amount",
    ]) {
      if (key in lanes && lanes[key] === 0 && metaRecord(p.evidence_packet_snapshot).money_lanes) {
        const snapLanes = metaRecord(p.evidence_packet_snapshot?.money_lanes);
        if (snapLanes[key] == null) coerced += 1;
      }
    }
  }
  return { pass: coerced === 0, coerced_non_null: coerced };
}

export async function composeClaimFilingPacketPreviewV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  query: ClaimFilingPacketPreviewQuery = {},
): Promise<ClaimFilingPacketPreviewPayload> {
  const pilotCaseRunId = str(query.pilot_case_run_id) || PILOT_CASE_RUN_ID;
  const intakeRunId = str(query.intake_run_id) || PILOT_INTAKE_RUN_ID;
  const status = str(query.status) || "open";
  const caseId = str(query.case_id) || null;
  const limit = Math.min(Math.max(caseId ? 100 : (query.limit ?? 50), 1), 100);

  const review = await buildClaimCaseReviewReadmodel(client, organizationId, storeId, {
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    status,
    limit,
  });

  let rows = review.rows;
  if (caseId) {
    rows = rows.filter((r) => r.id === caseId);
  }

  const previews = rows.map(mapCaseRowToFilingPacketPreviewV1);
  const stats = summarizeFilingPacketPreviews(previews);

  return {
    version: CLAIM_FILING_PACKET_PREVIEW_V1_VERSION,
    plan_version: CLAIM_FILING_PACKET_V1_PLAN_VERSION,
    composed_at: new Date().toISOString(),
    read_only: true,
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    default_status_filter: "open",
    previews,
    summary: {
      active_cases_loaded: previews.length,
      closed_duplicates_excluded_note:
        "status=open default excludes 10 remediated closed duplicates",
      ...stats,
    },
  };
}

/** Exported shape field list for audits. */
export const FILING_PACKET_PREVIEW_SHAPE_FIELDS = [
  "filing_packet_preview_id",
  "claim_case_id",
  "pilot_case_run_id",
  "intake_run_id",
  "claim_family",
  "claim_source",
  "claim_subtype",
  "case_status",
  "case_idempotency_key",
  "line_summary",
  "product_identity",
  "source_event_key",
  "source_event_date",
  "clean_quantity",
  "evidence_packet_snapshot",
  "evidence_summary",
  "source_edges",
  "reference_edges",
  "date_gate",
  "operator_attestation",
  "money_lanes",
  "warnings",
  "blockers",
  "readiness",
] as const;
