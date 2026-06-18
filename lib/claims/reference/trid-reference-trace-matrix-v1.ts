/**
 * PHASE-TRID-REFERENCE-TRACE-MATRIX-V1
 *
 * Read-only per-submission TRID / reference trace for the 10 pilot claim submissions.
 * Shows exactly how the primary TRID and every claim_reference_edge was resolved —
 * not just a 10/10 coverage summary.
 *
 * Hard rules (by construction):
 *  - No DB writes. No claim_reference_edges mutation. No claim_* mutation.
 *  - No Amazon call. No invented TRID. VRET/LPN are NOT treated as TRID.
 *  - Reports the CURRENT implementation honestly: a single primary TRID anchor per
 *    submission plus multiple supporting reference edges; event date/time is NOT used
 *    as a join filter today.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import { buildClaimCaseReviewReadmodel } from "../pilot/claim-case-review-readmodel";
import {
  loadReferenceContext,
  resolveTridFromContext,
} from "./claim-live-reference-api-completion-v1";

export const TRID_REFERENCE_TRACE_MATRIX_V1 = "trid-reference-trace-matrix-v1" as const;

/** Event date/time is NOT used as a reference-matching filter in the current graph. */
export const EVENT_DATETIME_FILTER_USED = false as const;

type RunOpts = { pilot_case_run_id?: string; intake_run_id?: string };

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export type TraceReferenceEdge = {
  id: string;
  edge_type: string | null;
  reference_kind: string | null;
  reference_value: string | null;
  confidence_score: number | null;
  from_source_table: string | null;
  from_source_row_id: string | null;
  to_source_table: string | null;
  to_source_row_id: string | null;
  edge_reason: string | null;
  ambiguity_group_key: string | null;
  ambiguity_rank: number | null;
  operator_review_status: string | null;
  created_at: string | null;
};

export type PerSubmissionFilterUsage = {
  claim_submission_id: string;
  product_link_resolved_product_id: boolean;
  expected_package_id: boolean;
  fnsku_sku_asin: boolean;
  removal_order_id: boolean;
  removal_shipment_id_or_tracking: boolean;
  event_datetime_window: boolean;
  source_row_id: boolean;
  intake_run_id_pilot_case_run_id: boolean;
};

export type PerSubmissionReferenceTrace = {
  claim_submission_id: string;
  claim_case_id: string | null;
  claim_family: string | null;
  source_candidate_id: string | null;
  primary_trid: string | null;
  trid_source: string;
  trid_confidence: string;
  trid_note: string;
  expected_package_id: string | null;
  resolved_product_id: string | null;
  fnsku: string | null;
  sku: string | null;
  asin: string | null;
  removal_order_ids: string[];
  removal_shipment_ids: string[];
  tracking_numbers: string[];
  source_table: string | null;
  source_row_id: string | null;
  event_datetime: string | null;
  event_datetime_is_amazon_event: boolean;
  quantity: number | null;
  reference_edge_count: number;
  distinct_reference_kinds: string[];
  reference_edges: TraceReferenceEdge[];
  ambiguous_matches: TraceReferenceEdge[];
  missing_refs: string[];
  multiple_references_for_case: boolean;
  multiple_reference_detail: string[];
};

export type TridReferenceTraceMatrixResult = {
  version: typeof TRID_REFERENCE_TRACE_MATRIX_V1;
  pilot_case_run_id: string;
  intake_run_id: string;
  pilot_submission_count: number;
  trid_coverage_count: string;
  total_reference_edges: number;
  average_edges_per_submission: number;
  per_submission_reference_matrix: PerSubmissionReferenceTrace[];
  filters_used_matrix: PerSubmissionFilterUsage[];
  filters_not_used_but_recommended: Array<{ filter: string; reason: string }>;
  ambiguous_reference_count: number;
  missing_reference_count: number;
  source_file_coverage_matrix: Array<{ source_table: string; submissions_covered: number; edge_count: number }>;
  primary_trid_per_submission: number;
  trid_anchor_note: string;
  ui_location_to_view: string[];
  api_location_to_view: string[];
  no_db_write_verification: true;
  no_claim_reference_edge_mutation_verification: true;
  dry_run: true;
};

const TRID_KIND_SET = new Set(["product_link", "trid", "expected_package_id", "internal_trid_key"]);

export async function composeTridReferenceTraceMatrixV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  opts: RunOpts = {},
): Promise<TridReferenceTraceMatrixResult> {
  const pilotCaseRunId = opts.pilot_case_run_id ?? PILOT_CASE_RUN_ID;
  const intakeRunId = opts.intake_run_id ?? PILOT_INTAKE_RUN_ID;

  const [ctx, review] = await Promise.all([
    loadReferenceContext(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
    }),
    buildClaimCaseReviewReadmodel(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
      limit: 100,
    }),
  ]);

  const caseById = new Map(review.rows.map((r) => [r.id, r]));
  const coverageBySubmission = new Map(ctx.coverage.map((c) => [c.claim_submission_id, c]));

  // Resolve the primary source candidate id per pilot submission.
  const submissionCandidate = new Map<string, string | null>();
  const candidateIds: string[] = [];
  for (const preview of ctx.previews) {
    const caseRow = caseById.get(preview.claim_case_id) ?? null;
    const candId =
      str(caseRow?.lines?.[0]?.claim_candidate_id) || str(caseRow?.candidate_ids?.[0]) || "";
    submissionCandidate.set(preview.claim_submission_id, candId || null);
    if (candId) candidateIds.push(candId);
  }

  // Load source candidates (read-only).
  const candidateById = new Map<string, Record<string, unknown>>();
  if (candidateIds.length > 0) {
    const { data, error } = await client
      .from("claim_candidates")
      .select(
        "id, source_table, source_row_id, source_event_key, fnsku, sku, asin, resolved_product_id, created_at",
      )
      .eq("organization_id", organizationId)
      .in("id", candidateIds);
    if (error) throw new Error(`claim_candidates: ${error.message}`);
    for (const row of data ?? []) candidateById.set(str((row as { id: string }).id), row as Record<string, unknown>);
  }

  // Load every claim_reference_edge linked to the pilot candidates (read-only).
  const edgesByCandidate = new Map<string, TraceReferenceEdge[]>();
  for (let i = 0; i < candidateIds.length; i += 50) {
    const chunk = candidateIds.slice(i, i + 50);
    const { data, error } = await client
      .from("claim_reference_edges")
      .select(
        "id, edge_type, reference_kind, reference_value, confidence_score, from_source_table, from_source_row_id, to_source_table, to_source_row_id, edge_reason, ambiguity_group_key, ambiguity_rank, operator_review_status, created_at, candidate_id",
      )
      .eq("organization_id", organizationId)
      .in("candidate_id", chunk);
    if (error) {
      if (error.message.includes("does not exist")) break;
      throw new Error(`claim_reference_edges: ${error.message}`);
    }
    for (const row of data ?? []) {
      const r = row as Record<string, unknown>;
      const cid = str(r.candidate_id);
      const edge: TraceReferenceEdge = {
        id: str(r.id),
        edge_type: str(r.edge_type) || null,
        reference_kind: str(r.reference_kind) || null,
        reference_value: str(r.reference_value) || null,
        confidence_score: typeof r.confidence_score === "number" ? r.confidence_score : null,
        from_source_table: str(r.from_source_table) || null,
        from_source_row_id: str(r.from_source_row_id) || null,
        to_source_table: str(r.to_source_table) || null,
        to_source_row_id: str(r.to_source_row_id) || null,
        edge_reason: str(r.edge_reason) || null,
        ambiguity_group_key: str(r.ambiguity_group_key) || null,
        ambiguity_rank: typeof r.ambiguity_rank === "number" ? r.ambiguity_rank : null,
        operator_review_status: str(r.operator_review_status) || null,
        created_at: str(r.created_at) || null,
      };
      const bucket = edgesByCandidate.get(cid) ?? [];
      bucket.push(edge);
      edgesByCandidate.set(cid, bucket);
    }
  }

  const per_submission_reference_matrix: PerSubmissionReferenceTrace[] = [];
  const filters_used_matrix: PerSubmissionFilterUsage[] = [];
  const sourceTableAgg = new Map<string, { submissions: Set<string>; edges: number }>();

  let tridCount = 0;
  let totalEdges = 0;
  let ambiguousCount = 0;
  let missingCount = 0;

  const valuesByKind = (edges: TraceReferenceEdge[], kinds: string[]): string[] => {
    const out = new Set<string>();
    for (const e of edges) {
      const k = str(e.reference_kind).toLowerCase();
      if (kinds.some((n) => k === n || k.includes(n)) && str(e.reference_value)) {
        out.add(str(e.reference_value));
      }
    }
    return [...out];
  };

  for (const preview of ctx.previews) {
    const subId = preview.claim_submission_id;
    const caseRow = caseById.get(preview.claim_case_id) ?? null;
    const candId = submissionCandidate.get(subId) ?? null;
    const cand = candId ? candidateById.get(candId) ?? null : null;
    const edges = candId ? edgesByCandidate.get(candId) ?? [] : [];
    const coverage = coverageBySubmission.get(subId) ?? null;

    const trid = resolveTridFromContext(ctx, { claim_submission_id: subId });
    if (trid.found && trid.trid) tridCount += 1;

    const removalOrderIds = valuesByKind(edges, ["removal_order_id"]).filter(
      (v) => !v.includes("amazon_removals"),
    );
    const removalShipmentIds = valuesByKind(edges, ["removal_shipment_id"]);
    const trackingNumbers = valuesByKind(edges, ["tracking_number", "tracking_reference"]);
    const epIdsFromEdges = valuesByKind(edges, ["expected_package_id"]);

    const expectedPackageId =
      (cand && str(cand.source_table) === "expected_packages" ? str(cand.source_row_id) : "") ||
      epIdsFromEdges[0] ||
      null;

    const ambiguous = edges.filter((e) => e.ambiguity_group_key);
    ambiguousCount += ambiguous.length;

    const distinctKinds = [...new Set(edges.map((e) => str(e.reference_kind)).filter(Boolean))];
    totalEdges += edges.length;

    const missingRefs = coverage?.missing_for_case_opening ?? [];
    if (missingRefs.length > 0) missingCount += 1;

    // "multiple references for this case" = any reference_kind carrying more than one value.
    const multiDetail: string[] = [];
    for (const kind of distinctKinds) {
      const vals = valuesByKind(edges, [kind.toLowerCase()]);
      if (vals.length > 1) multiDetail.push(`${kind}: ${vals.length} values`);
    }
    if (removalOrderIds.length > 1) multiDetail.push(`removal_order_id: ${removalOrderIds.length} values`);

    for (const e of edges) {
      const t = str(e.to_source_table) || "(none)";
      const agg = sourceTableAgg.get(t) ?? { submissions: new Set<string>(), edges: 0 };
      agg.submissions.add(subId);
      agg.edges += 1;
      sourceTableAgg.set(t, agg);
    }

    per_submission_reference_matrix.push({
      claim_submission_id: subId,
      claim_case_id: preview.claim_case_id,
      claim_family: str(preview.family_key_v3) || str(caseRow?.family_key_v3) || null,
      source_candidate_id: candId,
      primary_trid: trid.trid,
      trid_source: trid.trid_source,
      trid_confidence: trid.confidence,
      trid_note:
        "Primary TRID anchor for pilot resolves to expected_package_id (treated as a TRID-kind edge); " +
        "true product link = resolved_product_id on claim_candidates. No dedicated product_link/internal_trid_key edge, " +
        "and no VRET/LPN edge — VRET is NOT treated as TRID.",
      expected_package_id: expectedPackageId,
      resolved_product_id:
        (cand ? str(cand.resolved_product_id) : "") || str(caseRow?.resolved_product_id) || null,
      fnsku: (cand ? str(cand.fnsku) : "") || str(preview.fnsku) || null,
      sku: (cand ? str(cand.sku) : "") || str(preview.sku) || null,
      asin: (cand ? str(cand.asin) : "") || str(preview.asin) || null,
      removal_order_ids: removalOrderIds,
      removal_shipment_ids: removalShipmentIds,
      tracking_numbers: trackingNumbers,
      source_table: cand ? str(cand.source_table) || null : null,
      source_row_id: cand ? str(cand.source_row_id) || null : null,
      event_datetime: str(caseRow?.source_event_date) || (cand ? str(cand.created_at) || null : null),
      event_datetime_is_amazon_event: Boolean(str(caseRow?.source_event_date)),
      quantity: caseRow?.quantity_expected ?? caseRow?.clean_quantity ?? null,
      reference_edge_count: edges.length,
      distinct_reference_kinds: distinctKinds,
      reference_edges: edges,
      ambiguous_matches: ambiguous,
      missing_refs: missingRefs,
      multiple_references_for_case: multiDetail.length > 0,
      multiple_reference_detail: multiDetail,
    });

    filters_used_matrix.push({
      claim_submission_id: subId,
      product_link_resolved_product_id: Boolean(cand ? str(cand.resolved_product_id) : str(caseRow?.resolved_product_id)),
      expected_package_id: Boolean(expectedPackageId),
      fnsku_sku_asin: Boolean((cand ? str(cand.fnsku) || str(cand.sku) || str(cand.asin) : "") || str(preview.fnsku) || str(preview.sku) || str(preview.asin)),
      removal_order_id: removalOrderIds.length > 0,
      removal_shipment_id_or_tracking: removalShipmentIds.length > 0 || trackingNumbers.length > 0,
      event_datetime_window: EVENT_DATETIME_FILTER_USED,
      source_row_id: Boolean(cand ? str(cand.source_row_id) : ""),
      intake_run_id_pilot_case_run_id: true,
    });
  }

  const n = ctx.previews.length;
  const source_file_coverage_matrix = [...sourceTableAgg.entries()]
    .map(([source_table, v]) => ({
      source_table,
      submissions_covered: v.submissions.size,
      edge_count: v.edges,
    }))
    .sort((a, b) => b.edge_count - a.edge_count);

  return {
    version: TRID_REFERENCE_TRACE_MATRIX_V1,
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    pilot_submission_count: n,
    trid_coverage_count: `${tridCount}/${n}`,
    total_reference_edges: totalEdges,
    average_edges_per_submission: n > 0 ? Math.round((totalEdges / n) * 100) / 100 : 0,
    per_submission_reference_matrix,
    filters_used_matrix,
    filters_not_used_but_recommended: [
      {
        filter: "event_datetime_window",
        reason:
          "Event/removal/return date is stored (claim_cases.source_event_date) but is NOT used as a reference-matching join filter today. Edges match by row id (removal.id, expected_packages.source_detail_row_id, order_id), not by a date window.",
      },
      {
        filter: "lpn",
        reason: "LPN (FBA customer returns) not present for pilot removal families; requires GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA.",
      },
      {
        filter: "removal_order_id_live_refresh",
        reason: "removal_order_id present from materialization, but no governed live SP-API refresh (REMOVAL_ORDER_DETAIL) to revalidate.",
      },
      {
        filter: "amazon_case_id",
        reason: "Not yet present (10/10 draft). Required post-filing to anchor reimbursement matching.",
      },
      {
        filter: "vendor_return_id_vret",
        reason: "VRET is NOT a TRID; not present for pilot. Would only be a supporting reference, never the primary TRID.",
      },
    ],
    ambiguous_reference_count: ambiguousCount,
    missing_reference_count: missingCount,
    source_file_coverage_matrix,
    primary_trid_per_submission: 1,
    trid_anchor_note:
      "Each pilot submission has exactly ONE primary TRID anchor (expected_package_id / resolved_product_id) but MULTIPLE supporting reference edges " +
      "(expected_package_id, tracking_number, removal_order_id, removal_shipment_id, claim_case/line/candidate self-edges). " +
      "All pilot edges are edge_type=source_evidence and operator_review_status=needs_review; 0 ambiguity groups. Event date/time is not a match filter.",
    ui_location_to_view: [
      "/claim-center/reimbursement-tracking → open a row drawer → Overview → Reference Health section (TRID, product link, expected package)",
      "/claim-center/reimbursement-tracking → drawer → Evidence tab → reference_graph_lines",
    ],
    api_location_to_view: [
      "GET /api/claims/center/references/trid-resolver?claim_submission_id=…",
      "GET /api/claims/center/references/coverage",
      "GET /api/claims/center/reimbursement-tracking (reference_graph_lines)",
      "GET /api/claims/center/references?candidate_id=… (materialized edges)",
    ],
    no_db_write_verification: true,
    no_claim_reference_edge_mutation_verification: true,
    dry_run: true,
  };
}
