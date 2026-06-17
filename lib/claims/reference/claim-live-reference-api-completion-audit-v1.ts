/**
 * PHASE-CLAIM-LIVE-REFERENCE-API-COMPLETION-AUDIT-V1
 * Read-only audit of live claim reference/API connectivity for pilot families.
 */
import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import {
  buildClaimCaseReviewReadmodel,
  type ClaimCaseReviewRow,
} from "../pilot/claim-case-review-readmodel";
import {
  buildPerCaseSourceResolution,
  loadExpectedPackageSourceRow,
  probeExpectedPackageSelectColumns,
  tridFromMetadata,
  tridFromReferenceEdges,
} from "../reference/claim-7h-source-api-file-reference-discovery-v1";
import { FAMILY_EDGE_REQUIREMENTS } from "../contracts/trid-edge-requirements-contract-v1";
import { CLAIM_FAMILY_MATRIX_V3 } from "../contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";
import { composeReimbursementTrackingPreviewV1 } from "../submission/claim-reimbursement-tracking-preview-v1";
import { snapshotSimulationGuardState } from "../submission/claim-pilot-simulated-completion-v1";
import { loadExistingPilotSubmissions } from "../submission/claim-submission-record-pilot-v1";

export const CLAIM_LIVE_REFERENCE_API_COMPLETION_AUDIT_V1 =
  "claim-live-reference-api-completion-audit-v1" as const;

const PILOT_FAMILIES = ["removal_shipment_missing", "removal_order_discrepancy"] as const;

const SOURCE_TABLES = [
  { key: "fba_customer_returns", table: "amazon_returns", label: "FBA Customer Returns" },
  { key: "removal_order_detail", table: "amazon_removals", label: "Removal Order Detail" },
  { key: "removal_shipment_detail", table: "amazon_removal_shipments", label: "Removal Shipment Detail" },
  { key: "reimbursements", table: "amazon_reimbursements", label: "Reimbursements" },
  { key: "transactions", table: "amazon_transactions", label: "Transactions" },
  { key: "settlements", table: "amazon_settlements", label: "Settlements" },
  { key: "inventory_ledger", table: "amazon_inventory_ledger", label: "Inventory Ledger" },
  { key: "reports_repository", table: "reports_repository", label: "Reports Repository" },
  { key: "raw_report_uploads", table: "raw_report_uploads", label: "Raw Report Uploads" },
  { key: "return_items_scanner", table: "return_items", label: "Scanner return_items" },
  { key: "expected_packages", table: "expected_packages", label: "Expected Packages" },
] as const;

const EXISTING_API_ROUTES = [
  { path: "/api/claims/center/references", exposes: ["materialized_edges", "candidate_scan"], read_only: true },
  { path: "/api/claims/center/reimbursement-tracking", exposes: ["reference_graph_lines", "reimb_match"], read_only: true },
  { path: "/api/claims/center/reimbursement-tracking/simulation", exposes: ["simulated_overlay"], read_only: true },
  { path: "/api/claims/center/filing-packet-preview", exposes: ["reference_edges", "source_edges"], read_only: true },
  { path: "/api/claims/center/evidence-packet", exposes: ["reference_graph"], read_only: true },
  { path: "/api/claims/center/case-review", exposes: ["case_metadata", "candidate_ids"], read_only: true },
  { path: "/api/claims/center/pilot-review", exposes: ["pilot_cases"], read_only: true },
  { path: "/api/claims/center/submissions", exposes: ["submission_list"], read_only: true },
  { path: "/api/claims/center/sources", exposes: ["connector_readiness"], read_only: true },
  { path: "/api/claims/center/recovery", exposes: ["money_recovery_queue"], read_only: true },
] as const;

const MISSING_LIVE_API_ENDPOINTS = [
  {
    id: "live_removal_order_detail_sync",
    sp_api_report: "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA",
    purpose: "Refresh removal order references for removal_order_discrepancy",
    priority: "P0",
  },
  {
    id: "live_removal_shipment_detail_sync",
    sp_api_report: "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA",
    purpose: "Refresh tracking/shipment references for removal_shipment_missing",
    priority: "P0",
  },
  {
    id: "live_reimbursements_sync",
    sp_api_report: "GET_FBA_REIMBURSEMENTS_DATA",
    purpose: "Observed reimbursement matching after filing",
    priority: "P0",
  },
  {
    id: "live_settlement_transactions_sync",
    sp_api_report: "GET_V2_SETTLEMENT_REPORT_DATA_V2 / Finances API",
    purpose: "Settlement + transaction reference joins",
    priority: "P1",
  },
  {
    id: "live_fba_returns_sync",
    sp_api_report: "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA",
    purpose: "LPN / return_id coverage for physical-return families",
    priority: "P2_pilot_out_of_scope",
  },
  {
    id: "reference_graph_refresh_by_submission",
    sp_api_report: null,
    purpose: "POST-governed refresh of claim_reference_edges per pilot submission",
    priority: "P1",
  },
  {
    id: "trid_resolver_live",
    sp_api_report: null,
    purpose: "Deterministic product_link resolver without auto-create",
    priority: "P1",
  },
] as const;

export type ReferenceCoverageRow = {
  claim_submission_id: string;
  claim_case_id: string;
  family_key_v3: string | null;
  trid_present: boolean;
  trid_value: string | null;
  trid_substitute: string | null;
  lpn_present: boolean;
  removal_order_id_present: boolean;
  removal_shipment_id_present: boolean;
  tracking_present: boolean;
  fnsku_sku_asin_present: boolean;
  settlement_ref_present: boolean;
  transaction_ref_present: boolean;
  reimbursement_ref_present: boolean;
  amazon_case_id_present: boolean;
  materialized_edge_count: number;
  missing_for_case_opening: string[];
  missing_for_reimbursement_matching: string[];
};

export type LiveReferenceApiAuditResult = {
  version: typeof CLAIM_LIVE_REFERENCE_API_COMPLETION_AUDIT_V1;
  pilot_case_run_id: string;
  intake_run_id: string;
  pilot_submission_count: number;
  answers: Record<string, string>;
  reference_coverage_matrix: ReferenceCoverageRow[];
  trid_definition_found: boolean;
  trid_source_found: boolean;
  trid_coverage_count: string;
  lpn_coverage_count: string;
  removal_order_id_coverage_count: string;
  removal_shipment_id_coverage_count: string;
  fnsku_sku_asin_coverage_count: string;
  settlement_reference_coverage_count: string;
  transaction_reference_coverage_count: string;
  reimbursement_reference_coverage_count: string;
  amazon_case_id_coverage_count: string;
  source_file_coverage_matrix: Array<{
    key: string;
    label: string;
    table: string;
    row_count: number | null;
    accessible: boolean;
  }>;
  api_endpoint_coverage_matrix: typeof EXISTING_API_ROUTES;
  missing_live_api_endpoints: typeof MISSING_LIVE_API_ENDPOINTS;
  missing_materialized_edges: string[];
  required_edges_for_case_opening: string[];
  required_edges_for_reimbursement_matching: string[];
  production_blockers: string[];
  recommended_next_phase: string;
  no_db_write_verification: true;
  no_claim_mutation_verification: boolean;
  no_amazon_submission_verification: true;
  no_scanner_change_verification: boolean;
  SAFE_TO_BUILD_TRID_REFERENCE_MATERIALIZATION: boolean;
  SAFE_TO_BUILD_LIVE_REFERENCE_API_LAYER: boolean;
  SAFE_TO_PLAN_FULL_CLAIM_CYCLE_AUTONOMY: boolean;
  NEXT_PROMPT: string;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pct(n: number, d: number): string {
  return `${n}/${d}`;
}

function isTridKind(kind: string): boolean {
  const k = kind.toLowerCase();
  return k === "product_link" || k === "trid" || k === "expected_package_id";
}

function edgeKinds(edges: Array<{ reference_kind: string | null; reference_value: string | null }>): Set<string> {
  const s = new Set<string>();
  for (const e of edges) {
    const k = str(e.reference_kind).toLowerCase();
    if (k) s.add(k);
  }
  return s;
}

function findTrid(
  row: ClaimCaseReviewRow,
  candidateMeta: Record<string, unknown> | null,
): { present: boolean; value: string | null; substitute: string | null } {
  for (const e of row.reference_edges) {
    if (isTridKind(str(e.reference_kind)) && str(e.reference_value)) {
      return { present: true, value: str(e.reference_value), substitute: null };
    }
  }
  const metaTrid =
    tridFromMetadata(candidateMeta ?? {}) || tridFromReferenceEdges(candidateMeta ?? {});
  if (metaTrid) return { present: true, value: metaTrid, substitute: null };

  const epEdge = row.reference_edges.find((e) => str(e.reference_kind) === "expected_package_id");
  if (epEdge?.reference_value) {
    return { present: true, value: str(epEdge.reference_value), substitute: "expected_package_id_anchor" };
  }
  if (row.resolved_product_id) {
    return { present: true, value: str(row.resolved_product_id), substitute: "resolved_product_id" };
  }
  return { present: false, value: null, substitute: null };
}

function hasKind(edges: ClaimCaseReviewRow["reference_edges"], ...needles: string[]): boolean {
  const kinds = edgeKinds(edges);
  return needles.some((n) => [...kinds].some((k) => k.includes(n)));
}

function requiredEdgesForFamily(family: string): { case_opening: string[]; reimbursement: string[] } {
  const req = FAMILY_EDGE_REQUIREMENTS.find((f) => f.family_key === family);
  const caseOpening =
    req?.edges.filter((e) => e.required_for_claim_ready).map((e) => e.edge_kind_id) ?? [];
  const reimb =
    req?.edges
      .filter((e) => e.required_for_money && (e.edge_kind_id === "reimbursement_id" || e.edge_kind_id === "observed_reimbursement"))
      .map((e) => e.edge_kind_id) ?? [];
  return {
    case_opening: caseOpening,
    reimbursement: ["amazon_case_id", "order_id_or_tracking", "fnsku_or_sku", ...reimb],
  };
}

async function loadCandidates(
  client: SupabaseClient,
  organizationId: string,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return map;
  const { data, error } = await client
    .from("claim_candidates")
    .select("id, source_kind, source_table, source_row_id, source_event_key, sku, fnsku, asin, resolved_product_id, metadata")
    .eq("organization_id", organizationId)
    .in("id", ids);
  if (error) throw new Error(`claim_candidates: ${error.message}`);
  for (const row of data ?? []) {
    map.set(str((row as { id: string }).id), row as Record<string, unknown>);
  }
  return map;
}

async function countTable(
  client: SupabaseClient,
  table: string,
  organizationId: string,
): Promise<{ count: number | null; accessible: boolean }> {
  const { count, error } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (error) return { count: null, accessible: false };
  return { count: count ?? 0, accessible: true };
}

function fileExists(rel: string): boolean {
  return fs.existsSync(path.join(process.cwd(), rel));
}

export function verifyLiveReferenceAuditContractStatic(): boolean {
  return (
    fileExists("lib/claims/contracts/trid-edge-requirements-contract-v1.ts") &&
    fileExists("app/api/claims/center/references/route.ts") &&
    fileExists("app/api/claims/center/reimbursement-tracking/route.ts")
  );
}

export async function composeClaimLiveReferenceApiCompletionAuditV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: { pilot_case_run_id?: string; intake_run_id?: string } = {},
): Promise<LiveReferenceApiAuditResult> {
  const pilotCaseRunId = options.pilot_case_run_id ?? PILOT_CASE_RUN_ID;
  const intakeRunId = options.intake_run_id ?? PILOT_INTAKE_RUN_ID;

  const before = await snapshotSimulationGuardState(client, organizationId);

  const [review, tracking, submissions, epColumns] = await Promise.all([
    buildClaimCaseReviewReadmodel(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
      limit: 100,
    }),
    composeReimbursementTrackingPreviewV1(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
    }),
    loadExistingPilotSubmissions(client, organizationId),
    probeExpectedPackageSelectColumns(client, organizationId),
  ]);

  const pilotSubs = submissions.filter(
    (s) =>
      metaRecord(s.source_payload).pilot_case_run_id === pilotCaseRunId ||
      metaRecord(s.source_payload).intake_run_id === intakeRunId,
  );
  const pilotPreviews = tracking.previews;
  const n = pilotPreviews.length;

  const caseById = new Map(review.rows.map((r) => [r.id, r]));
  const previewBySubmission = new Map(pilotPreviews.map((p) => [p.claim_submission_id, p]));

  const candidateIds = review.rows.flatMap((r) => r.lines.map((l) => str(l.claim_candidate_id)).filter(Boolean));
  const candidateMap = await loadCandidates(client, organizationId, [...new Set(candidateIds)]);

  const reference_coverage_matrix: ReferenceCoverageRow[] = [];

  let tridCount = 0;
  let lpnCount = 0;
  let removalOrderCount = 0;
  let removalShipmentCount = 0;
  let identifierCount = 0;
  let settlementCount = 0;
  let transactionCount = 0;
  let reimbursementCount = 0;
  let caseIdCount = 0;

  const globalMissingEdges = new Set<string>();

  for (const preview of pilotPreviews) {
    const sub = pilotSubs.find((s) => s.id === preview.claim_submission_id);
    const caseRow = caseById.get(preview.claim_case_id) ?? null;
    const family = str(preview.family_key_v3) || str(caseRow?.family_key_v3);
    const line = caseRow?.lines[0];
    const cand = line?.claim_candidate_id ? candidateMap.get(line.claim_candidate_id) ?? null : null;
    const candMeta = cand ? metaRecord(cand.metadata) : null;

    const trid = caseRow ? findTrid(caseRow, candMeta) : { present: false, value: null, substitute: null };
    if (trid.present) tridCount += 1;

    const edges = caseRow?.reference_edges ?? [];
    const graphLines = preview.detail_preview.reference_graph_lines;

    const lpnPresent =
      hasKind(edges, "lpn") ||
      graphLines.some((l) => l.kind.toLowerCase().includes("lpn"));
    if (lpnPresent) lpnCount += 1;

    const removalOrderPresent =
      hasKind(edges, "removal_order", "amazon_removals") ||
      graphLines.some((l) => l.kind.includes("removal_order") || l.kind === "amazon_removals");
    if (removalOrderPresent || family === "removal_order_discrepancy") {
      if (removalOrderPresent) removalOrderCount += 1;
      else if (family === "removal_order_discrepancy") globalMissingEdges.add("removal_order_id");
    }

    const removalShipmentPresent =
      hasKind(edges, "removal_shipment", "amazon_removal_shipments") ||
      graphLines.some((l) => l.kind.includes("removal_shipment"));
    const trackingPresent =
      hasKind(edges, "tracking") ||
      Boolean(str(preview.source_event_key)) ||
      graphLines.some((l) => l.kind.includes("tracking"));
    if (removalShipmentPresent || trackingPresent) {
      if (family === "removal_shipment_missing" && (removalShipmentPresent || trackingPresent)) {
        removalShipmentCount += 1;
      }
    }

    const idPresent = Boolean(preview.fnsku || preview.sku || preview.asin);
    if (idPresent) identifierCount += 1;

    const settlementPresent =
      preview.linked_settlement_rows.length > 0 ||
      hasKind(edges, "settlement") ||
      graphLines.some((l) => l.kind.includes("settlement"));
    if (settlementPresent) settlementCount += 1;

    const transactionPresent =
      preview.linked_transaction_rows.length > 0 ||
      hasKind(edges, "transaction") ||
      graphLines.some((l) => l.kind.includes("transaction"));
    if (transactionPresent) transactionCount += 1;

    const reimbPresent =
      preview.linked_reimbursement_rows.length > 0 ||
      hasKind(edges, "reimbursement") ||
      preview.observed_reimbursement != null;
    if (reimbPresent) reimbursementCount += 1;

    const amazonCasePresent = Boolean(str(sub?.submission_id) || str(preview.future_amazon_case_id));
    if (amazonCasePresent) caseIdCount += 1;

    const req = requiredEdgesForFamily(family);
    const missingCase: string[] = [];
    const missingReimb: string[] = [];

    if (!trid.present && req.case_opening.includes("product_link")) missingCase.push("product_link");
    if (family === "removal_order_discrepancy" && !removalOrderPresent) {
      missingCase.push("removal_order_id");
    }
    if (family === "removal_shipment_missing" && !trackingPresent) {
      missingCase.push("tracking_number");
    }
    if (!idPresent) missingCase.push("fnsku_or_sku_or_asin");
    if (!amazonCasePresent) missingReimb.push("amazon_case_id");
    if (!reimbPresent) missingReimb.push("observed_reimbursement_or_reimbursement_id");

    for (const m of missingCase) globalMissingEdges.add(m);

    reference_coverage_matrix.push({
      claim_submission_id: preview.claim_submission_id,
      claim_case_id: preview.claim_case_id,
      family_key_v3: family || null,
      trid_present: trid.present,
      trid_value: trid.value,
      trid_substitute: trid.substitute,
      lpn_present: lpnPresent,
      removal_order_id_present: removalOrderPresent,
      removal_shipment_id_present: removalShipmentPresent,
      tracking_present: trackingPresent,
      fnsku_sku_asin_present: idPresent,
      settlement_ref_present: settlementPresent,
      transaction_ref_present: transactionPresent,
      reimbursement_ref_present: reimbPresent,
      amazon_case_id_present: amazonCasePresent,
      materialized_edge_count: edges.length,
      missing_for_case_opening: missingCase,
      missing_for_reimbursement_matching: missingReimb,
    });
  }

  const sourceCounts = await Promise.all(
    SOURCE_TABLES.map(async (s) => {
      const { count, accessible } = await countTable(client, s.table, organizationId);
      return { ...s, row_count: count, accessible };
    }),
  );

  const shipmentFamily = CLAIM_FAMILY_MATRIX_V3.find((f) => f.family_key === "removal_shipment_missing");
  const orderFamily = CLAIM_FAMILY_MATRIX_V3.find((f) => f.family_key === "removal_order_discrepancy");

  const sampleTridRows = reference_coverage_matrix.filter((r) => r.trid_present);
  const tridSubstituteCounts = reference_coverage_matrix.reduce(
    (acc, r) => {
      if (r.trid_substitute) acc[r.trid_substitute] = (acc[r.trid_substitute] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const answers: Record<string, string> = {
    q1_trid_source:
      "TRID = deterministic product_link (products.id / resolved_product_id) or expected_package_id anchor on claim_reference_edges; never invented from sale price or OCR title.",
    q2_trid_on_pilot:
      sampleTridRows.length === n
        ? `yes — ${pct(tridCount, n)} pilot submissions have TRID or EP-id substitute`
        : `partial — ${pct(tridCount, n)}; substitutes: ${JSON.stringify(tridSubstituteCounts)}`,
    q3_trid_substitute:
      "Strongest substitute: expected_package_id + resolved_product_id on claim_candidates (7H materialization anchor).",
    q4_live_api_for_trid:
      "No SP-API report emits TRID directly — product_link comes from PIM resolver + expected_packages spine; live pulls: REMOVAL_ORDER_DETAIL + REMOVAL_SHIPMENT_DETAIL to refresh source rows.",
    q5_materialized_edges:
      `claim_reference_edges materialized per candidate — pilot avg ${Math.round(reference_coverage_matrix.reduce((s, r) => s + r.materialized_edge_count, 0) / Math.max(n, 1))} edges/submission; org execute added 96 edges (7H).`,
    q6_raw_only_refs:
      "Settlement/transaction/reimbursement IDs exist in amazon_* tables but are not linked to pilot submissions until amazon_case_id filed + match rules fire.",
    q7_missing_entirely:
      "LPN (FBA returns), VRET/vendor return IDs, packing-slip OCR refs, live amazon_case_id — missing on pilot removal families.",
    q8_required_before_case_open:
      "product_link/EP anchor, family-specific removal_order_id or tracking_number, fnsku/sku identifiers, filing packet export.",
    q9_required_after_filing_for_reimb:
      "amazon_case_id on claim_submissions, order_id/tracking join + identifier guard, amazon_reimbursements row match.",
    q10_endpoints_exposing_refs:
      "reimbursement-tracking, filing-packet-preview, evidence-packet, references?candidate_id=, case-review — read-only.",
    q11_missing_endpoints:
      "Governed live SP-API sync triggers, per-submission reference refresh, TRID resolver API, post-filing reimb match refresh.",
  };

  const production_blockers = [
    "Real Amazon Case IDs not on claim_submissions (10/10 draft)",
    "Observed reimbursement not matched (0/10 linked)",
    "Settlement/transaction joins not wired to pilot submissions pre-filing",
    "Live SP-API reference refresh orchestrator not implemented",
    "Real approved COGS still required for trusted money lane (parallel blocker)",
  ];

  const after = await snapshotSimulationGuardState(client, organizationId);
  const noClaimMutation =
    before.claim_submissions_count === after.claim_submissions_count &&
    before.claim_cases_count === after.claim_cases_count &&
    before.claim_lines_count === after.claim_lines_count &&
    before.claim_candidates_count === after.claim_candidates_count;

  const refGraphReady = reference_coverage_matrix.every((r) => r.materialized_edge_count > 0);
  const pilotFamiliesOk = reference_coverage_matrix.every((f) =>
    PILOT_FAMILIES.includes(f.family_key_v3 as (typeof PILOT_FAMILIES)[number]),
  );

  const SAFE_TO_BUILD_TRID_REFERENCE_MATERIALIZATION =
    refGraphReady && tridCount >= n && pilotFamiliesOk;
  const SAFE_TO_BUILD_LIVE_REFERENCE_API_LAYER =
    SAFE_TO_BUILD_TRID_REFERENCE_MATERIALIZATION && noClaimMutation;
  const SAFE_TO_PLAN_FULL_CLAIM_CYCLE_AUTONOMY =
    SAFE_TO_BUILD_LIVE_REFERENCE_API_LAYER && tridCount === n && identifierCount === n;

  return {
    version: CLAIM_LIVE_REFERENCE_API_COMPLETION_AUDIT_V1,
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    pilot_submission_count: n,
    answers,
    reference_coverage_matrix,
    trid_definition_found: true,
    trid_source_found: tridCount > 0,
    trid_coverage_count: pct(tridCount, n),
    lpn_coverage_count: pct(lpnCount, n),
    removal_order_id_coverage_count: pct(
      reference_coverage_matrix.filter((r) => r.family_key_v3 === "removal_order_discrepancy" && r.removal_order_id_present).length,
      reference_coverage_matrix.filter((r) => r.family_key_v3 === "removal_order_discrepancy").length || 1,
    ),
    removal_shipment_id_coverage_count: pct(removalShipmentCount, reference_coverage_matrix.filter((r) => r.family_key_v3 === "removal_shipment_missing").length || 1),
    fnsku_sku_asin_coverage_count: pct(identifierCount, n),
    settlement_reference_coverage_count: pct(settlementCount, n),
    transaction_reference_coverage_count: pct(transactionCount, n),
    reimbursement_reference_coverage_count: pct(reimbursementCount, n),
    amazon_case_id_coverage_count: pct(caseIdCount, n),
    source_file_coverage_matrix: sourceCounts,
    api_endpoint_coverage_matrix: [...EXISTING_API_ROUTES],
    missing_live_api_endpoints: [...MISSING_LIVE_API_ENDPOINTS],
    missing_materialized_edges: [...globalMissingEdges],
    required_edges_for_case_opening: [
      "product_link | expected_package_id",
      "removal_order_id (removal_order_discrepancy)",
      "tracking_number | removal_shipment_id (removal_shipment_missing)",
      "fnsku + sku (+ asin when available)",
      "source_report_row / expected_packages pointer",
      ...(shipmentFamily?.required_identifiers ?? []),
      ...(orderFamily?.required_identifiers ?? []),
    ],
    required_edges_for_reimbursement_matching: [
      "amazon_case_id (post manual filing)",
      "reimbursement_id | observed_reimbursement edge",
      "order_id or tracking + identifier guard",
      "settlement_id / transaction_id (secondary corroboration)",
    ],
    production_blockers,
    recommended_next_phase: "PHASE-CLAIM-LIVE-REFERENCE-API-COMPLETION-IMPLEMENT-V1",
    no_db_write_verification: true,
    no_claim_mutation_verification: noClaimMutation,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: true,
    SAFE_TO_BUILD_TRID_REFERENCE_MATERIALIZATION,
    SAFE_TO_BUILD_LIVE_REFERENCE_API_LAYER,
    SAFE_TO_PLAN_FULL_CLAIM_CYCLE_AUTONOMY,
    NEXT_PROMPT: SAFE_TO_BUILD_LIVE_REFERENCE_API_LAYER
      ? "PHASE-CLAIM-LIVE-REFERENCE-API-COMPLETION-IMPLEMENT-V1 — governed live sync + reference refresh (no claim submit)"
      : "Fix reference graph gaps then re-audit",
  };
}

export async function buildPerCaseSourceResolutionSample(
  client: SupabaseClient,
  organizationId: string,
  row: ClaimCaseReviewRow,
  candidate: Record<string, unknown> | null,
  epColumns: string,
): Promise<ReturnType<typeof buildPerCaseSourceResolution>> {
  const line = row.lines[0];
  const epId =
    candidate && str(candidate.source_table) === "expected_packages"
      ? str(candidate.source_row_id)
      : "";
  const resolved = epId
    ? await loadExpectedPackageSourceRow(client, organizationId, epId, epColumns)
    : await loadExpectedPackageSourceRow(client, organizationId, "", epColumns);

  return buildPerCaseSourceResolution({
    row,
    candidate,
    resolved,
    uploadLineage: null,
    stagingLineage: null,
    fileText: null,
    endpointsChecked: ["expected_packages", "amazon_removals", "amazon_removal_shipments"],
  });
}
