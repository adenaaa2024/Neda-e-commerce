/**
 * PHASE-CLAIM-PILOT-PREFILING-FINAL-VERIFY-V1
 *
 * Read-only production pre-filing verification for the 10 pilot claim submissions.
 * Composes existing read-models only — no DB writes, no claim_* mutation, no Amazon,
 * no scanner change, no AI. The caller script adds UI/git/build/smoke checks.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import { composeClaimFilingPacketPreviewV1 } from "../filing/claim-filing-packet-preview-v1";
import { composeMoneyLanePreviewAfterCogsV1 } from "./claim-money-lane-preview-after-cogs-v1";
import { composeMoneyLanePreviewV2 } from "./claim-money-lane-preview-v2-profit-loss-v1";
import { composeReimbursementTrackingPreviewV1 } from "./claim-reimbursement-tracking-preview-v1";
import { composeTridReferenceTraceMatrixV1 } from "../reference/trid-reference-trace-matrix-v1";
import { loadCogsOverridesForOrg } from "./product-cogs-audit-v1";
import { extractCogsOverrideUnitCost } from "./cogs-override-value-v1";
import { PILOT_FNSKUS_V1 } from "./product-cogs-manual-entry-ui-v1";

export const CLAIM_PILOT_PREFILING_FINAL_VERIFY_V1 =
  "claim-pilot-prefiling-final-verify-v1" as const;

export const EXPECTED_PILOT_SUBMISSION_COUNT = 10 as const;

/** Latest verified total recovery value (PHASE-CLAIM-MONEY-LANE-PREVIEW-AFTER-COGS-V2 20260619T074000Z). */
export const EXPECTED_TOTAL_RECOVERY_VALUE = 100.72 as const;

type RunOpts = { pilot_case_run_id?: string; intake_run_id?: string };

function str(v: unknown): string {
  return String(v ?? "").trim();
}

export type PrefilingCheck = {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
};

export type ClaimPilotPrefilingDataVerification = {
  version: typeof CLAIM_PILOT_PREFILING_FINAL_VERIFY_V1;
  pilot_case_run_id: string;
  intake_run_id: string;

  pilot_submission_count: number;
  claim_families_verified: Record<string, number>;

  cogs_overrides_count: number;
  cogs_overrides_expected: number;
  cogs_coverage_count: string;
  recovery_value_coverage: string;
  total_recovery_value: number | null;

  money_lane_verification: {
    latest_sold_price_coverage: string;
    amazon_fee_coverage: string;
    net_settlement_coverage: string;
    recovery_value_coverage: string;
    observed_reimbursement_coverage: string;
    cogs_coverage_count: number;
    reimbursement_pending_handling: boolean;
    sale_price_not_used_as_cogs_verification: boolean;
    null_preservation_verification: boolean;
    total_recovery_value: number | null;
    v2_fee_view_coverage: string;
    v2_settlement_view_coverage: string;
    v2_reimbursement_coverage: string;
    SAFE_MONEY_LANE_PREVIEW_READY: boolean;
  };

  trid_coverage_count: string;
  reference_materialization_verification: {
    total_reference_edges: number;
    average_edges_per_submission: number;
    ambiguous_reference_count: number;
    missing_reference_count: number;
    edges_visible: boolean;
  };
  per_submission_reference_edge_matrix: Array<{
    claim_submission_id: string;
    claim_case_id: string | null;
    claim_family: string | null;
    primary_trid_present: boolean;
    trid_source: string;
    reference_edge_count: number;
    distinct_reference_kinds: string[];
    ambiguous_matches: number;
    missing_refs: string[];
  }>;

  filing_packet_verification: {
    previews_count: number;
    ready_for_pdf_preview_count: number;
    ready_for_manual_filing_count: number;
    evidence_present_count: number;
    all_have_packet: boolean;
  };

  observed_reimbursement_status: string;

  data_checks: PrefilingCheck[];
  data_checks_passed: number;
  data_checks_total: number;
};

export async function composeClaimPilotPrefilingFinalVerifyV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: RunOpts = {},
): Promise<ClaimPilotPrefilingDataVerification> {
  const opts = {
    pilot_case_run_id: options.pilot_case_run_id ?? PILOT_CASE_RUN_ID,
    intake_run_id: options.intake_run_id ?? PILOT_INTAKE_RUN_ID,
  };

  const [tracking, money, moneyV2, trace, packet, overrides] = await Promise.all([
    composeReimbursementTrackingPreviewV1(client, organizationId, storeId, opts),
    composeMoneyLanePreviewAfterCogsV1(client, organizationId, storeId, opts),
    composeMoneyLanePreviewV2(client, organizationId, storeId, opts),
    composeTridReferenceTraceMatrixV1(client, organizationId, storeId, opts),
    composeClaimFilingPacketPreviewV1(client, organizationId, storeId, {
      pilot_case_run_id: opts.pilot_case_run_id,
      intake_run_id: opts.intake_run_id,
      status: "open",
      limit: 100,
    }),
    loadCogsOverridesForOrg(client, organizationId),
  ]);

  const pilotSubmissionCount = tracking.pilot_submissions.length;

  // COGS overrides among the 6 pilot FNSKUs.
  const cogsOverridesCount = PILOT_FNSKUS_V1.filter(
    (fnsku) => extractCogsOverrideUnitCost(overrides[fnsku]) != null,
  ).length;

  // Family distribution (from the money lane matrix).
  const families: Record<string, number> = {};
  for (const row of money.per_submission_money_matrix) {
    const fam = row.family ?? "unknown";
    families[fam] = (families[fam] ?? 0) + 1;
  }

  // Filing packet readiness / evidence presence.
  const evidencePresentCount = packet.previews.filter(
    (p) => p.evidence_packet_snapshot != null || str(p.evidence_summary) !== "",
  ).length;

  const tridCovered = Number(str(trace.trid_coverage_count).split("/")[0] || "0");
  const expected = EXPECTED_PILOT_SUBMISSION_COUNT;
  const fullCov = (s: string) => s === `${expected}/${expected}`;

  const observedReimbursementStatus =
    money.reimbursement_pending_handling && (money.total_observed_reimbursement ?? 0) === 0
      ? "Unknown/Pending (not $0)"
      : `observed_total=${money.total_observed_reimbursement}`;

  const perSubmissionReferenceEdgeMatrix = trace.per_submission_reference_matrix.map((s) => ({
    claim_submission_id: s.claim_submission_id,
    claim_case_id: s.claim_case_id,
    claim_family: s.claim_family,
    primary_trid_present: Boolean(s.primary_trid),
    trid_source: s.trid_source,
    reference_edge_count: s.reference_edge_count,
    distinct_reference_kinds: s.distinct_reference_kinds,
    ambiguous_matches: s.ambiguous_matches.length,
    missing_refs: s.missing_refs,
  }));

  const totalRecoveryValue = money.total_recovery_value;
  const totalRecoveryMatches =
    totalRecoveryValue != null &&
    Math.abs(totalRecoveryValue - EXPECTED_TOTAL_RECOVERY_VALUE) < 0.005;

  const checks: PrefilingCheck[] = [
    {
      id: "pilot_submissions_visible",
      label: "10/10 pilot submissions exist and visible",
      pass: pilotSubmissionCount === expected,
      detail: `${pilotSubmissionCount}/${expected} pilot submissions`,
    },
    {
      id: "cogs_overrides_exist",
      label: "6/6 COGS overrides exist",
      pass: cogsOverridesCount === PILOT_FNSKUS_V1.length,
      detail: `${cogsOverridesCount}/${PILOT_FNSKUS_V1.length} pilot FNSKU overrides`,
    },
    {
      id: "recovery_values_calculated",
      label: "10/10 recovery values calculated",
      pass: fullCov(money.recovery_value_coverage),
      detail: money.recovery_value_coverage,
    },
    {
      id: "total_recovery_value_matches_latest_verified",
      label: `total_recovery_value populated and equals latest verified ($${EXPECTED_TOTAL_RECOVERY_VALUE})`,
      pass: totalRecoveryMatches,
      detail: `total_recovery_value=${totalRecoveryValue} (expected ${EXPECTED_TOTAL_RECOVERY_VALUE})`,
    },
    {
      id: "latest_sold_price_coverage",
      label: "10/10 latest_sold_price coverage",
      pass: fullCov(money.latest_sold_price_coverage),
      detail: money.latest_sold_price_coverage,
    },
    {
      id: "amazon_fee_coverage",
      label: "10/10 amazon_fee coverage",
      pass: fullCov(money.amazon_fee_coverage),
      detail: money.amazon_fee_coverage,
    },
    {
      id: "net_settlement_coverage",
      label: "10/10 net_settlement coverage",
      pass: fullCov(money.net_settlement_coverage),
      detail: money.net_settlement_coverage,
    },
    {
      id: "observed_reimbursement_pending_not_zero",
      label: "observed reimbursement Unknown/Pending (not $0)",
      pass: money.reimbursement_pending_handling,
      detail: `${money.observed_reimbursement_coverage} · ${observedReimbursementStatus}`,
    },
    {
      id: "trid_coverage",
      label: "10/10 TRID coverage",
      pass: tridCovered >= expected,
      detail: trace.trid_coverage_count,
    },
    {
      id: "reference_edges_materialized_visible",
      label: "reference edges materialized & visible (0 ambiguous / 0 missing)",
      pass:
        trace.total_reference_edges > 0 &&
        trace.ambiguous_reference_count === 0 &&
        trace.missing_reference_count === 0,
      detail: `${trace.total_reference_edges} edges · ambiguous ${trace.ambiguous_reference_count} · missing ${trace.missing_reference_count}`,
    },
    {
      id: "per_submission_reference_edge_counts_visible",
      label: "per-submission reference edge counts visible (all > 0)",
      pass:
        perSubmissionReferenceEdgeMatrix.length === expected &&
        perSubmissionReferenceEdgeMatrix.every((r) => r.reference_edge_count > 0),
      detail: `${perSubmissionReferenceEdgeMatrix.length} rows · edges per submission: ${perSubmissionReferenceEdgeMatrix
        .map((r) => r.reference_edge_count)
        .join("/")}`,
    },
    {
      id: "filing_packet_exists",
      label: "filing/evidence packet exists per submission",
      pass: packet.previews.length === expected,
      detail: `${packet.previews.length} packets · ready_pdf ${packet.summary.ready_for_pdf_preview_count} · ready_filing ${packet.summary.ready_for_manual_filing_count} · evidence ${evidencePresentCount}`,
    },
  ];

  const passed = checks.filter((c) => c.pass).length;

  return {
    version: CLAIM_PILOT_PREFILING_FINAL_VERIFY_V1,
    pilot_case_run_id: opts.pilot_case_run_id,
    intake_run_id: opts.intake_run_id,
    pilot_submission_count: pilotSubmissionCount,
    claim_families_verified: families,
    cogs_overrides_count: cogsOverridesCount,
    cogs_overrides_expected: PILOT_FNSKUS_V1.length,
    cogs_coverage_count: `${money.cogs_coverage_count}/${pilotSubmissionCount}`,
    recovery_value_coverage: money.recovery_value_coverage,
    total_recovery_value: money.total_recovery_value,
    money_lane_verification: {
      latest_sold_price_coverage: money.latest_sold_price_coverage,
      amazon_fee_coverage: money.amazon_fee_coverage,
      net_settlement_coverage: money.net_settlement_coverage,
      recovery_value_coverage: money.recovery_value_coverage,
      observed_reimbursement_coverage: money.observed_reimbursement_coverage,
      cogs_coverage_count: money.cogs_coverage_count,
      reimbursement_pending_handling: money.reimbursement_pending_handling,
      sale_price_not_used_as_cogs_verification: money.sale_price_not_used_as_cogs_verification,
      null_preservation_verification: money.null_preservation_verification,
      total_recovery_value: money.total_recovery_value,
      v2_fee_view_coverage: moneyV2.fee_view_coverage,
      v2_settlement_view_coverage: moneyV2.settlement_view_coverage,
      v2_reimbursement_coverage: moneyV2.reimbursement_coverage,
      SAFE_MONEY_LANE_PREVIEW_READY: money.SAFE_MONEY_LANE_PREVIEW_READY,
    },
    trid_coverage_count: trace.trid_coverage_count,
    reference_materialization_verification: {
      total_reference_edges: trace.total_reference_edges,
      average_edges_per_submission: trace.average_edges_per_submission,
      ambiguous_reference_count: trace.ambiguous_reference_count,
      missing_reference_count: trace.missing_reference_count,
      edges_visible: trace.total_reference_edges > 0,
    },
    per_submission_reference_edge_matrix: perSubmissionReferenceEdgeMatrix,
    filing_packet_verification: {
      previews_count: packet.previews.length,
      ready_for_pdf_preview_count: packet.summary.ready_for_pdf_preview_count,
      ready_for_manual_filing_count: packet.summary.ready_for_manual_filing_count,
      evidence_present_count: evidencePresentCount,
      all_have_packet: packet.previews.length === expected,
    },
    observed_reimbursement_status: observedReimbursementStatus,
    data_checks: checks,
    data_checks_passed: passed,
    data_checks_total: checks.length,
  };
}

/** Static smoke gate — confirms contract constants without DB. */
export function verifyClaimPilotPrefilingContractStatic(): boolean {
  return (
    EXPECTED_PILOT_SUBMISSION_COUNT === 10 &&
    PILOT_FNSKUS_V1.length === 6 &&
    PILOT_CASE_RUN_ID === "pilot-20260615T190000Z" &&
    PILOT_INTAKE_RUN_ID === "a8a892fe-37d5-4d74-9ea2-02af8fd095ce"
  );
}
