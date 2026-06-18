/**
 * PHASE-CLAIM-MONEY-LANE-RECOVERY-AUDIT-V1
 * Read-only audit: why pilot money lanes are NULL and what sources exist.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadCogsOverridesCanonicalV1 } from "./product-cogs-source-write-v1";
import type { ClaimCaseReviewRow } from "../pilot/claim-case-review-readmodel";
import { buildClaimCaseReviewReadmodel } from "../pilot/claim-case-review-readmodel";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import {
  composeReimbursementTrackingPreviewV1,
  extractJoinKeys,
  type ReimbursementTrackingPreviewRow,
} from "./claim-reimbursement-tracking-preview-v1";
import {
  extractClaimCaseIdFromSubmission,
  loadExistingPilotSubmissions,
} from "./claim-submission-record-pilot-v1";

export const CLAIM_MONEY_LANE_RECOVERY_AUDIT_V1_VERSION =
  "claim-money-lane-recovery-audit-v1" as const;

export type SourceProbe = {
  found: boolean;
  detail: string;
  sample_values?: Record<string, unknown>;
};

export type PerSubmissionMoneyMatrix = {
  claim_submission_id: string;
  claim_case_id: string;
  family: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  quantity: number | null;
  estimated_amount_source_found: boolean;
  recovery_value_source_found: boolean;
  observed_reimbursement_source_found: boolean;
  cost_source_found: boolean;
  fee_source_found: boolean;
  reimbursement_match_source_found: boolean;
  source_probes: {
    case_metadata_money_lanes: SourceProbe;
    claim_lines_metadata: SourceProbe;
    claim_candidates_money: SourceProbe;
    expected_packages: SourceProbe;
    removal_order_shipment: SourceProbe;
    reimbursements_report: SourceProbe;
    transactions_report: SourceProbe;
    settlements_report: SourceProbe;
    inventory_ledger: SourceProbe;
    product_cogs: SourceProbe;
    identifier_map: SourceProbe;
    product_linkage: SourceProbe;
  };
  blocker_reasons: string[];
  recommended_next_action: string;
  sale_price_present_not_used_as_cogs: boolean;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function hasMoneyKey(lanes: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => num(lanes[k]) != null);
}

function laneBlockers(args: {
  caseLanes: Record<string, unknown>;
  submissionLanes: Record<string, unknown>;
  candidateRecovery: number | null;
  candidateCogs: number | null;
  feePreviewCount: number;
  cogsOverride: boolean;
  costSnapshotCount: number;
  linkedReimbCount: number;
  family: string | null;
  qty: number | null;
  productLinked: boolean;
}): string[] {
  const blockers: string[] = [];
  const estKeys = ["estimated_amazon_payout", "expected_amount"];
  const recKeys = ["recovery_value", "internal_cost_loss"];
  const obsKeys = ["observed_reimbursement"];

  if (
    !hasMoneyKey(args.caseLanes, estKeys) &&
    !hasMoneyKey(args.submissionLanes, estKeys) &&
    args.feePreviewCount === 0
  ) {
    blockers.push("estimated_amount_no_case_or_fee_preview_source");
  }
  if (
    !hasMoneyKey(args.caseLanes, recKeys) &&
    !hasMoneyKey(args.submissionLanes, recKeys) &&
    args.candidateRecovery == null &&
    args.candidateCogs == null &&
    args.costSnapshotCount === 0 &&
    !args.cogsOverride
  ) {
    blockers.push("recovery_value_no_cogs_or_recovery_column");
  }
  if (args.qty != null && args.candidateCogs == null && args.costSnapshotCount === 0 && !args.cogsOverride) {
    blockers.push("family_formula_blocked_missing_actual_cost_basis");
  }
  if (
    !hasMoneyKey(args.caseLanes, obsKeys) &&
    !hasMoneyKey(args.submissionLanes, obsKeys) &&
    args.linkedReimbCount === 0
  ) {
    blockers.push("observed_reimbursement_no_safe_match_and_not_filed");
  }
  if (!args.productLinked) blockers.push("product_linkage_incomplete_for_cost_spine");
  if (args.family?.includes("removal") && args.feePreviewCount === 0) {
    blockers.push("removal_family_uses_cogs_times_qty_not_sale_price");
  }
  return [...new Set(blockers)];
}

function recommendAction(blockers: string[]): string {
  if (blockers.includes("family_formula_blocked_missing_actual_cost_basis")) {
    return "Run Product/COGS audit — wire unit cost (product_cost_snapshots or governed cogs_overrides) before estimating recovery";
  }
  if (blockers.includes("observed_reimbursement_no_safe_match_and_not_filed")) {
    return "Expected NULL until manual filing + Amazon response; run reimbursement matching audit after case ID filed";
  }
  if (blockers.includes("estimated_amount_no_case_or_fee_preview_source")) {
    return "Populate fee-adjusted estimate read-model inputs (amazon_fee_preview) or snapshot money_lanes at case creation";
  }
  return "Review money lane sources per submission matrix";
}

async function safeCount(
  client: SupabaseClient,
  table: string,
  filters: Array<{ col: string; op: "eq" | "in"; val: string | string[] }>,
): Promise<number> {
  let q = client.from(table).select("id", { count: "exact", head: true });
  for (const f of filters) {
    if (f.op === "eq") q = q.eq(f.col, f.val as string);
    else q = q.in(f.col, f.val as string[]);
  }
  const { count, error } = await q;
  if (error) {
    if (error.message.includes("does not exist") || error.message.includes("schema cache")) return 0;
    throw new Error(`${table}: ${error.message}`);
  }
  return count ?? 0;
}

async function safeSelect(
  client: SupabaseClient,
  table: string,
  select: string,
  filters: Array<{ col: string; op: "eq" | "in"; val: string | string[] }>,
  limit = 5,
): Promise<Record<string, unknown>[]> {
  let q = client.from(table).select(select).limit(limit);
  for (const f of filters) {
    if (f.op === "eq") q = q.eq(f.col, f.val as string);
    else q = q.in(f.col, f.val as string[]);
  }
  const { data, error } = await q;
  if (error) {
    if (error.message.includes("does not exist") || error.message.includes("schema cache")) return [];
    throw new Error(`${table}: ${error.message}`);
  }
  return (data ?? []) as unknown as Record<string, unknown>[];
}

export async function auditMoneyLaneRecoveryV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: { pilot_case_run_id?: string; intake_run_id?: string } = {},
): Promise<{
  pilot_submission_count: number;
  previews: ReimbursementTrackingPreviewRow[];
  per_submission_money_matrix: PerSubmissionMoneyMatrix[];
  money_lane_coverage_summary: Record<string, number>;
  blockers_by_lane: Record<string, string[]>;
  org_spine_counts: {
    amazon_fee_preview: number;
    amazon_reimbursements: number;
    product_cost_snapshots: number;
    product_identifier_map: number;
  };
  safe_calculation_possible: {
    estimated_amount: "yes" | "conditional" | "no";
    recovery_value: "yes" | "conditional" | "no";
    observed_reimbursement: "yes" | "conditional" | "no";
  };
  recommendations: {
    product_cogs_audit_required: boolean;
    reimbursement_matching_audit_required: boolean;
    migration_needed: boolean;
    ui_warning_sufficient: boolean;
  };
}> {
  const pilotCaseRunId = str(options.pilot_case_run_id) || PILOT_CASE_RUN_ID;
  const intakeRunId = str(options.intake_run_id) || PILOT_INTAKE_RUN_ID;

  const composed = await composeReimbursementTrackingPreviewV1(client, organizationId, storeId, {
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
  });

  const review = await buildClaimCaseReviewReadmodel(client, organizationId, storeId, {
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    status: "open",
    limit: 100,
  });
  const caseById = new Map(review.rows.map((r) => [r.id, r]));

  const [feePreviewOrg, reimbOrg, costSnapOrg, mapOrg, cogsOverrides] = await Promise.all([
    safeCount(client, "amazon_fee_preview", [{ col: "organization_id", op: "eq", val: organizationId }]),
    safeCount(client, "amazon_reimbursements", [{ col: "organization_id", op: "eq", val: organizationId }]),
    safeCount(client, "product_cost_snapshots", [{ col: "organization_id", op: "eq", val: organizationId }]),
    safeCount(client, "product_identifier_map", [{ col: "organization_id", op: "eq", val: organizationId }]),
    // Canonical workspace_settings resolver (org-scoped first, singleton fallback).
    loadCogsOverridesCanonicalV1(client, organizationId),
  ]);

  const matrix: PerSubmissionMoneyMatrix[] = [];

  for (const preview of composed.previews) {
    const submission = composed.pilot_submissions.find((s) => s.id === preview.claim_submission_id);
    const caseRow = caseById.get(preview.claim_case_id) ?? null;
    const payload = metaRecord(submission?.source_payload);
    const submissionLanes = metaRecord(payload.money_lanes);
    const caseLanes = caseRow?.money_lanes ?? {};

    const candidateIds = caseRow?.candidate_ids ?? [];
    const candidateRows = candidateIds.length
      ? await safeSelect(
          client,
          "claim_candidates",
          "id, recovery_value, cogs_unit, metadata, claim_family",
          [{ col: "id", op: "in", val: candidateIds }],
          10,
        )
      : [];

    const lineRows = await safeSelect(
      client,
      "claim_lines",
      "id, metadata, expected_package_id, resolved_product_id, sku, fnsku, asin",
      [{ col: "claim_case_id", op: "eq", val: preview.claim_case_id }],
      5,
    );

    const joinKeys = extractJoinKeys({ submission: submission!, caseRow });
    const tracking = preview.source_event_key ?? caseRow?.source_event_key ?? null;
    const epRows = tracking
      ? await safeSelect(
          client,
          "expected_packages",
          "id, tracking_number, expected_scan_quantity, metadata",
          [
            { col: "organization_id", op: "eq", val: organizationId },
            { col: "tracking_number", op: "eq", val: tracking },
          ],
          3,
        )
      : [];

    const removalOrderIds = [...joinKeys.removal_order_ids];
    const removalRows =
      removalOrderIds.length > 0
        ? await safeSelect(
            client,
            "amazon_removals",
            "id, removal_order_id, shipped_quantity, metadata",
            [
              { col: "organization_id", op: "eq", val: organizationId },
              { col: "removal_order_id", op: "in", val: removalOrderIds.slice(0, 20) },
            ],
            3,
          )
        : [];

    const shipmentIds = [...joinKeys.removal_shipment_ids];
    const shipmentRows =
      shipmentIds.length > 0
        ? await safeSelect(
            client,
            "amazon_removal_shipments",
            "id, removal_order_id, tracking_number, shipped_quantity, metadata",
            [
              { col: "organization_id", op: "eq", val: organizationId },
              { col: "removal_order_id", op: "in", val: shipmentIds.slice(0, 20) },
            ],
            3,
          )
        : [];

    const productId = preview.product_identity.resolved_product_id;
    const feeForProduct =
      productId && preview.asin
        ? await safeCount(client, "amazon_fee_preview", [
            { col: "organization_id", op: "eq", val: organizationId },
            { col: "asin", op: "eq", val: preview.asin },
          ])
        : 0;

    const costForProduct =
      productId
        ? await safeCount(client, "product_cost_snapshots", [
            { col: "organization_id", op: "eq", val: organizationId },
            { col: "product_id", op: "eq", val: productId },
          ])
        : 0;

    const mapFilters: Array<{ col: string; op: "eq" | "in"; val: string | string[] }> = [
      { col: "organization_id", op: "eq", val: organizationId },
    ];
    if (preview.fnsku) mapFilters.push({ col: "fnsku", op: "eq", val: preview.fnsku });
    else if (preview.asin) mapFilters.push({ col: "asin", op: "eq", val: preview.asin });
    else if (preview.sku) mapFilters.push({ col: "seller_sku", op: "eq", val: preview.sku });

    const mapHits =
      mapFilters.length > 1
        ? await safeCount(client, "product_identifier_map", mapFilters)
        : 0;

    const ledgerCount =
      tracking
        ? await safeCount(client, "amazon_inventory_ledger", [
            { col: "organization_id", op: "eq", val: organizationId },
            { col: "reference_id", op: "eq", val: tracking },
          ])
        : 0;

    const candidateRecovery = candidateRows.map((r) => num(r.recovery_value)).find((v) => v != null) ?? null;
    const candidateCogs = candidateRows.map((r) => num(r.cogs_unit)).find((v) => v != null) ?? null;
    const lineMoney = lineRows.some((r) => {
      const lineMeta = metaRecord(r.metadata);
      return hasMoneyKey(metaRecord(lineMeta.money_lanes), ["recovery_value", "estimated_amazon_payout"]);
    });
    const caseEst = hasMoneyKey(caseLanes, ["estimated_amazon_payout", "expected_amount"]);
    const caseRec = hasMoneyKey(caseLanes, ["recovery_value", "internal_cost_loss"]);
    const caseObs = hasMoneyKey(caseLanes, ["observed_reimbursement"]);
    const subEst = hasMoneyKey(submissionLanes, ["estimated_amazon_payout", "expected_amount"]);
    const subRec = hasMoneyKey(submissionLanes, ["recovery_value", "internal_cost_loss"]);
    const subObs = hasMoneyKey(submissionLanes, ["observed_reimbursement"]);

    const cogsOverrideHit =
      Boolean(preview.sku && cogsOverrides[preview.sku] != null) ||
      Boolean(preview.fnsku && cogsOverrides[preview.fnsku] != null) ||
      Boolean(preview.asin && cogsOverrides[preview.asin] != null);

    const productLinked = Boolean(productId) || mapHits > 0;
    const linkedReimb = preview.linked_reimbursement_count;

    const blockers = laneBlockers({
      caseLanes,
      submissionLanes,
      candidateRecovery,
      candidateCogs,
      feePreviewCount: feeForProduct,
      cogsOverride: cogsOverrideHit,
      costSnapshotCount: costForProduct,
      linkedReimbCount: linkedReimb,
      family: preview.family_key_v3,
      qty: preview.clean_quantity,
      productLinked,
    });

    let salePricePresent = false;
    if (productId) {
      const prod = await safeSelect(client, "products", "id, sale_price, list_price", [
        { col: "id", op: "eq", val: productId },
      ], 1);
      salePricePresent = prod.some((p) => num(p.sale_price) != null || num(p.list_price) != null);
    }

    matrix.push({
      claim_submission_id: preview.claim_submission_id,
      claim_case_id: preview.claim_case_id,
      family: preview.family_key_v3,
      sku: preview.sku,
      fnsku: preview.fnsku,
      asin: preview.asin,
      quantity: preview.clean_quantity,
      estimated_amount_source_found: caseEst || subEst || feeForProduct > 0,
      recovery_value_source_found: caseRec || subRec || candidateRecovery != null || candidateCogs != null || costForProduct > 0 || cogsOverrideHit,
      observed_reimbursement_source_found: caseObs || subObs || linkedReimb > 0,
      cost_source_found: candidateCogs != null || costForProduct > 0 || cogsOverrideHit,
      fee_source_found: feeForProduct > 0 || caseEst || subEst,
      reimbursement_match_source_found: linkedReimb > 0,
      source_probes: {
        case_metadata_money_lanes: {
          found: Object.keys(caseLanes).length > 0,
          detail: Object.keys(caseLanes).length ? `keys: ${Object.keys(caseLanes).join(", ")}` : "empty",
          sample_values: caseLanes,
        },
        claim_lines_metadata: {
          found: lineMoney || lineRows.length > 0,
          detail: lineRows.length ? `${lineRows.length} line(s); money in metadata: ${lineMoney}` : "no lines",
        },
        claim_candidates_money: {
          found: candidateRecovery != null || candidateCogs != null,
          detail: `candidates=${candidateIds.length}; recovery_value=${candidateRecovery}; cogs_unit=${candidateCogs}`,
        },
        expected_packages: {
          found: epRows.length > 0,
          detail: epRows.length ? `rows=${epRows.length} for tracking ${tracking}` : "no EP row for tracking",
        },
        removal_order_shipment: {
          found: removalRows.length > 0 || shipmentRows.length > 0,
          detail: `removals=${removalRows.length}; shipments=${shipmentRows.length}`,
        },
        reimbursements_report: {
          found: linkedReimb > 0,
          detail: linkedReimb > 0 ? `matched=${linkedReimb}` : "no reference-safe reimbursement match",
        },
        transactions_report: {
          found: preview.linked_transaction_rows.length > 0,
          detail: `matched=${preview.linked_transaction_rows.length}`,
        },
        settlements_report: {
          found: preview.linked_settlement_rows.length > 0,
          detail: `matched=${preview.linked_settlement_rows.length}`,
        },
        inventory_ledger: {
          found: ledgerCount > 0,
          detail: `rows=${ledgerCount}`,
        },
        product_cogs: {
          found: costForProduct > 0 || cogsOverrideHit || candidateCogs != null,
          detail: `snapshots=${costForProduct}; override=${cogsOverrideHit}; cogs_unit=${candidateCogs}`,
        },
        identifier_map: {
          found: mapHits > 0,
          detail: `map_hits=${mapHits}`,
        },
        product_linkage: {
          found: productLinked,
          detail: `resolved_product_id=${productId ?? "null"}`,
        },
      },
      blocker_reasons: blockers,
      recommended_next_action: recommendAction(blockers),
      sale_price_present_not_used_as_cogs: salePricePresent,
    });
  }

  const coverage = {
    estimated_amount: matrix.filter((m) => m.estimated_amount_source_found).length,
    recovery_value: matrix.filter((m) => m.recovery_value_source_found).length,
    observed_reimbursement: matrix.filter((m) => m.observed_reimbursement_source_found).length,
    cost: matrix.filter((m) => m.cost_source_found).length,
    fee: matrix.filter((m) => m.fee_source_found).length,
    reimbursement_match: matrix.filter((m) => m.reimbursement_match_source_found).length,
  };

  const blockersByLane: Record<string, string[]> = {
    estimated_amount: [],
    recovery_value: [],
    observed_reimbursement: [],
  };
  for (const m of matrix) {
    for (const b of m.blocker_reasons) {
      if (b.includes("estimated") || b.includes("fee_preview")) {
        if (!blockersByLane.estimated_amount!.includes(b)) blockersByLane.estimated_amount!.push(b);
      }
      if (b.includes("recovery") || b.includes("cogs") || b.includes("cost_basis")) {
        if (!blockersByLane.recovery_value!.includes(b)) blockersByLane.recovery_value!.push(b);
      }
      if (b.includes("observed") || b.includes("reimbursement")) {
        if (!blockersByLane.observed_reimbursement!.includes(b)) blockersByLane.observed_reimbursement!.push(b);
      }
    }
  }

  const anyCost = coverage.cost > 0;
  const anyFee = coverage.fee > 0;
  const anyObs = coverage.observed_reimbursement > 0;

  return {
    pilot_submission_count: matrix.length,
    previews: composed.previews,
    per_submission_money_matrix: matrix,
    money_lane_coverage_summary: coverage,
    blockers_by_lane: blockersByLane,
    org_spine_counts: {
      amazon_fee_preview: feePreviewOrg,
      amazon_reimbursements: reimbOrg,
      product_cost_snapshots: costSnapOrg,
      product_identifier_map: mapOrg,
    },
    safe_calculation_possible: {
      estimated_amount: anyFee ? "conditional" : "no",
      recovery_value: anyCost ? "conditional" : "no",
      observed_reimbursement: anyObs ? "conditional" : "no",
    },
    recommendations: {
      product_cogs_audit_required: !anyCost,
      reimbursement_matching_audit_required: coverage.reimbursement_match === 0,
      migration_needed: costSnapOrg === 0,
      ui_warning_sufficient: true,
    },
  };
}
