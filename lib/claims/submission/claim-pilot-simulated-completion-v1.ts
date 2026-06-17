/**
 * PHASE-CLAIM-PILOT-SIMULATED-COMPLETION-V1
 * Read-only end-to-end simulation — no DB writes, no production claims.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import { composeMoneyLanePreviewV1 } from "./claim-money-lane-preview-v1";
import { MONEY_LANE_INTEGRATION_FORMULA_CONTRACT } from "./claim-money-lane-preview-ui-integration-v1";
import { loadCogsOverridesForOrg } from "./product-cogs-audit-v1";
import { PILOT_FNSKUS_V1 } from "./product-cogs-manual-entry-ui-v1";

export const CLAIM_PILOT_SIMULATED_COMPLETION_V1 = "claim-pilot-simulated-completion-v1" as const;

/** Neutral sample unit costs — never copied from latest_sold_price. */
export const SIMULATED_PILOT_COGS_UNIT_COSTS_V1: Record<
  string,
  { fnsku: string; sku: string; unitCost: number; currency: string }
> = {
  X004D9AMWV: { fnsku: "X004D9AMWV", sku: "I6-VR35-FSXQ", unitCost: 5.0, currency: "USD" },
  X003VSWH37: { fnsku: "X003VSWH37", sku: "2025JUN08-B0057FBQTC", unitCost: 6.5, currency: "USD" },
  X004TRQBB3: { fnsku: "X004TRQBB3", sku: "WD-VY8Z-CZ3F", unitCost: 4.25, currency: "USD" },
  X004LLJMN1: { fnsku: "X004LLJMN1", sku: "2H-7ZAX-Z2IP", unitCost: 3.75, currency: "USD" },
  X004WJ8OE5: { fnsku: "X004WJ8OE5", sku: "FBA-B0FYDT88GQ", unitCost: 8.0, currency: "USD" },
  X004N992LN: { fnsku: "X004N992LN", sku: "B075XC6C69-VEN", unitCost: 4.5, currency: "USD" },
};

export type SimulatedCogsInputRow = {
  fnsku: string;
  sku: string;
  unitCost: number;
  currency: string;
  effectiveDate: string;
  sourceNote: string;
  approvedBy: string;
  sourceType: "simulation_only";
  simulation_only: true;
  salePriceReviewConfirmed: false;
  _reference_latest_sold_price: number | null;
};

export type SimulatedManualFilingInputRow = {
  claim_submission_id: string;
  claim_case_id: string;
  amazon_case_id: string;
  external_case_id: string;
  filed_at: string;
  filed_by: string;
  filing_notes: string;
  operator_already_filed_in_seller_central: true;
  manual_filing_recorded: true;
  external_platform: "amazon_seller_central_simulated";
  tracking_status: "filed_waiting_for_amazon";
  not_submitted_to_amazon: true;
  simulation_only: true;
  old_status: string;
  new_status_simulated: "submitted";
};

export type SimulatedMoneyLaneRow = {
  claim_submission_id: string;
  claim_case_id: string;
  family: string | null;
  clean_quantity: number | null;
  fnsku: string | null;
  sku: string | null;
  latest_sold_price: number | null;
  amazon_fees_total: number | null;
  net_settlement_amount: number | null;
  approved_cogs_unit: number | null;
  approved_cogs_unit_simulated: true;
  recovery_value: number | null;
  observed_reimbursement: null;
  open_recovery_gap: null;
  open_recovery_gap_display: "Pending";
  profit_context: number | null;
  simulation_only: true;
};

export type SimulatedSubmissionStatusRow = {
  claim_submission_id: string;
  claim_case_id: string;
  fnsku: string | null;
  old_status: string;
  simulated_status: "submitted";
  simulated_external_case_id: string;
  simulated_tracking_status: "filed_waiting_for_amazon";
  simulation_only: true;
};

export type SimulatedUiDemoPayload = {
  simulation_only: true;
  mode: "simulation_demo";
  banner: {
    title: "Simulation mode";
    lines: string[];
  };
  pilot_submission_count: number;
  rows: Array<{
    claim_submission_id: string;
    claim_case_id: string;
    fnsku: string | null;
    sku: string | null;
    submission_status_simulated: "submitted";
    future_amazon_case_id: string;
    reimbursement_tracking_status: "filed_waiting_for_amazon";
    recovery_value: number | null;
    observed_reimbursement: null;
    financial_gap_display: "Pending";
    not_submitted_to_amazon: true;
    simulation_only: true;
  }>;
};

export type ClaimPilotSimulatedCompletionResult = {
  version: typeof CLAIM_PILOT_SIMULATED_COMPLETION_V1;
  simulation_only: true;
  pilot_case_run_id: string;
  intake_run_id: string;
  pilot_submission_count: number;
  simulated_cogs_count: number;
  simulated_manual_filing_count: number;
  simulated_recovery_value_coverage: string;
  simulated_case_id_coverage: string;
  observed_reimbursement_status: "Unknown";
  simulated_cogs_input: { simulation_only: true; entries: SimulatedCogsInputRow[] };
  simulated_manual_filing_input: { simulation_only: true; entries: SimulatedManualFilingInputRow[] };
  simulated_money_lane_matrix: SimulatedMoneyLaneRow[];
  simulated_submission_status_matrix: SimulatedSubmissionStatusRow[];
  simulated_end_to_end_summary: Record<string, unknown>;
  ui_demo_payload: SimulatedUiDemoPayload;
  production_blockers_remaining: string[];
  sale_price_not_used_as_cogs_verification: boolean;
  no_db_write_verification: true;
  production_write_performed: false;
  SAFE_CLAIM_PILOT_SIMULATION_COMPLETE: boolean;
  SAFE_TO_RUN_FINAL_SIMULATION_VERIFY: boolean;
  NEXT_PROMPT: string;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function simCaseId(index: number): string {
  return `SIM-AMZ-CASE-${String(index).padStart(4, "0")}`;
}

export function buildSimulatedCogsInput(
  moneyPreview: Awaited<ReturnType<typeof composeMoneyLanePreviewV1>>,
): SimulatedCogsInputRow[] {
  const soldByFnsku = new Map<string, number | null>();
  for (const p of moneyPreview.per_submission_money_preview) {
    const f = str(p.fnsku);
    if (f && !soldByFnsku.has(f)) {
      soldByFnsku.set(f, p.latest_sold_price.value);
    }
  }

  return (PILOT_FNSKUS_V1 as readonly string[]).map((fnsku) => {
    const row = SIMULATED_PILOT_COGS_UNIT_COSTS_V1[fnsku]!;
    return {
      fnsku,
      sku: row.sku,
      unitCost: row.unitCost,
      currency: row.currency,
      effectiveDate: "2026-06-15",
      sourceNote: "SIMULATION ONLY - not approved COGS",
      approvedBy: "simulation",
      sourceType: "simulation_only" as const,
      simulation_only: true as const,
      salePriceReviewConfirmed: false as const,
      _reference_latest_sold_price: soldByFnsku.get(fnsku) ?? null,
    };
  });
}

export function verifySimulatedCogsNotSalePrice(
  cogsInput: SimulatedCogsInputRow[],
  moneyPreview: Awaited<ReturnType<typeof composeMoneyLanePreviewV1>>,
): boolean {
  const soldByFnsku = new Map<string, number | null>();
  for (const p of moneyPreview.per_submission_money_preview) {
    const f = str(p.fnsku);
    if (f) soldByFnsku.set(f, p.latest_sold_price.value);
  }
  for (const row of cogsInput) {
    const sold = soldByFnsku.get(row.fnsku);
    if (sold != null && sold > 0 && sold === row.unitCost) return false;
  }
  return true;
}

export async function composeClaimPilotSimulatedCompletionV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: { pilot_case_run_id?: string; intake_run_id?: string } = {},
): Promise<ClaimPilotSimulatedCompletionResult> {
  const pilotCaseRunId = options.pilot_case_run_id ?? PILOT_CASE_RUN_ID;
  const intakeRunId = options.intake_run_id ?? PILOT_INTAKE_RUN_ID;

  const moneyPreview = await composeMoneyLanePreviewV1(client, organizationId, storeId, {
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
  });

  const sorted = [...moneyPreview.per_submission_money_preview].sort((a, b) =>
    a.claim_submission_id.localeCompare(b.claim_submission_id),
  );

  const simulatedCogsInput = buildSimulatedCogsInput(moneyPreview);
  const cogsByFnsku = new Map(simulatedCogsInput.map((r) => [r.fnsku, r.unitCost]));

  const simulatedManualFiling: SimulatedManualFilingInputRow[] = sorted.map((p, i) => {
    const caseId = simCaseId(i + 1);
    return {
      claim_submission_id: p.claim_submission_id,
      claim_case_id: p.claim_case_id,
      amazon_case_id: caseId,
      external_case_id: caseId,
      filed_at: "2026-06-18T12:00:00Z",
      filed_by: "simulation",
      filing_notes: "SIMULATION ONLY - not filed in Seller Central",
      operator_already_filed_in_seller_central: true,
      manual_filing_recorded: true,
      external_platform: "amazon_seller_central_simulated",
      tracking_status: "filed_waiting_for_amazon",
      not_submitted_to_amazon: true,
      simulation_only: true,
      old_status: "draft",
      new_status_simulated: "submitted",
    };
  });

  const simulatedMoneyLane: SimulatedMoneyLaneRow[] = sorted.map((p) => {
    const fnsku = str(p.fnsku) || null;
    const cogs = fnsku ? (cogsByFnsku.get(fnsku) ?? null) : null;
    const qty = p.clean_quantity;
    const recovery = cogs != null && qty != null ? cogs * qty : null;
    const fees = p.amazon_fee_breakdown.amazon_fees_total;
    const sold = p.latest_sold_price.value;
    const profit =
      sold != null && fees != null && cogs != null ? sold - fees - cogs : null;

    return {
      claim_submission_id: p.claim_submission_id,
      claim_case_id: p.claim_case_id,
      family: p.family,
      clean_quantity: qty,
      fnsku,
      sku: str(p.sku) || null,
      latest_sold_price: sold,
      amazon_fees_total: fees,
      net_settlement_amount: p.net_settlement_amount.value,
      approved_cogs_unit: cogs,
      approved_cogs_unit_simulated: true,
      recovery_value: recovery,
      observed_reimbursement: null,
      open_recovery_gap: null,
      open_recovery_gap_display: "Pending",
      profit_context: profit,
      simulation_only: true,
    };
  });

  const simulatedStatus: SimulatedSubmissionStatusRow[] = simulatedManualFiling.map((f) => ({
    claim_submission_id: f.claim_submission_id,
    claim_case_id: f.claim_case_id,
    fnsku: str(sorted.find((s) => s.claim_submission_id === f.claim_submission_id)?.fnsku) || null,
    old_status: f.old_status,
    simulated_status: "submitted",
    simulated_external_case_id: f.external_case_id,
    simulated_tracking_status: "filed_waiting_for_amazon",
    simulation_only: true,
  }));

  const recoveryKnown = simulatedMoneyLane.filter((r) => r.recovery_value != null).length;
  const n = sorted.length;
  const salePriceOk = verifySimulatedCogsNotSalePrice(simulatedCogsInput, moneyPreview);

  const totalRecovery = simulatedMoneyLane.reduce<number | null>((acc, r) => {
    if (r.recovery_value == null) return acc;
    return (acc ?? 0) + r.recovery_value;
  }, null);

  const productionBlockers = [
    "Real approved COGS not in cogs_overrides (6/6 missing)",
    "Real Amazon Case IDs not recorded on claim_submissions (10/10 draft)",
    "Observed reimbursement not matched (expected until Amazon pays)",
  ];

  const uiDemoPayload: SimulatedUiDemoPayload = {
    simulation_only: true,
    mode: "simulation_demo",
    banner: {
      title: "Simulation mode",
      lines: [
        "Not production data",
        "No Amazon submission",
        "No DB writes",
        "COGS and case IDs are simulated for demo only",
      ],
    },
    pilot_submission_count: n,
    rows: simulatedMoneyLane.map((m, i) => ({
      claim_submission_id: m.claim_submission_id,
      claim_case_id: m.claim_case_id,
      fnsku: m.fnsku,
      sku: m.sku,
      submission_status_simulated: "submitted" as const,
      future_amazon_case_id: simulatedManualFiling[i]!.external_case_id,
      reimbursement_tracking_status: "filed_waiting_for_amazon" as const,
      recovery_value: m.recovery_value,
      observed_reimbursement: null,
      financial_gap_display: "Pending" as const,
      not_submitted_to_amazon: true,
      simulation_only: true as const,
    })),
  };

  const simulationComplete =
    n === 10 &&
    simulatedCogsInput.length === 6 &&
    simulatedManualFiling.length === 10 &&
    recoveryKnown === 10 &&
    salePriceOk;

  return {
    version: CLAIM_PILOT_SIMULATED_COMPLETION_V1,
    simulation_only: true,
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    pilot_submission_count: n,
    simulated_cogs_count: simulatedCogsInput.length,
    simulated_manual_filing_count: simulatedManualFiling.length,
    simulated_recovery_value_coverage: `${recoveryKnown}/${n}`,
    simulated_case_id_coverage: `${simulatedManualFiling.length}/${n}`,
    observed_reimbursement_status: "Unknown",
    simulated_cogs_input: { simulation_only: true, entries: simulatedCogsInput },
    simulated_manual_filing_input: { simulation_only: true, entries: simulatedManualFiling },
    simulated_money_lane_matrix: simulatedMoneyLane,
    simulated_submission_status_matrix: simulatedStatus,
    simulated_end_to_end_summary: {
      simulation_only: true,
      formula_contract: MONEY_LANE_INTEGRATION_FORMULA_CONTRACT,
      total_recovery_value_simulated: totalRecovery,
      total_observed_reimbursement: null,
      total_open_gap: null,
      open_gap_display: "Pending",
      cogs_source: "simulation_only — not cogs_overrides",
      filing_source: "simulation_only — not claim_submissions",
      production_execute_blocked_reasons: productionBlockers,
    },
    ui_demo_payload: uiDemoPayload,
    production_blockers_remaining: productionBlockers,
    sale_price_not_used_as_cogs_verification: salePriceOk,
    no_db_write_verification: true,
    production_write_performed: false,
    SAFE_CLAIM_PILOT_SIMULATION_COMPLETE: simulationComplete,
    SAFE_TO_RUN_FINAL_SIMULATION_VERIFY: simulationComplete,
    NEXT_PROMPT: simulationComplete
      ? "PHASE-CLAIM-PILOT-SIMULATION-VERIFY-V1 — open Reimbursement Tracking ?simulation=1 demo"
      : "Fix simulation composer coverage before verify",
  };
}

export async function snapshotSimulationGuardState(
  client: SupabaseClient,
  organizationId: string,
): Promise<{
  claim_submissions_count: number;
  claim_cases_count: number;
  claim_lines_count: number;
  claim_candidates_count: number;
  cogs_override_keys: string[];
}> {
  const [subs, cases, lines, cands, overrides] = await Promise.all([
    client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    loadCogsOverridesForOrg(client, organizationId),
  ]);

  return {
    claim_submissions_count: subs.count ?? 0,
    claim_cases_count: cases.count ?? 0,
    claim_lines_count: lines.count ?? 0,
    claim_candidates_count: cands.count ?? 0,
    cogs_override_keys: Object.keys(overrides).filter((k) => !k.startsWith("_")),
  };
}

export function verifySimulationContractStatic(): boolean {
  return (
    Object.keys(SIMULATED_PILOT_COGS_UNIT_COSTS_V1).length === 6 &&
    SIMULATED_PILOT_COGS_UNIT_COSTS_V1.X004WJ8OE5!.unitCost !== 22.99 &&
    SIMULATED_PILOT_COGS_UNIT_COSTS_V1.X003VSWH37!.unitCost !== 14.99
  );
}

export type ReimbursementTrackingSimulationUiPayload = {
  simulation_only: true;
  simulation_mode: true;
  simulation_banner: SimulatedUiDemoPayload["banner"];
  simulation_run_reference: string;
  base_preview_run_reference: string;
  ui_demo_payload: SimulatedUiDemoPayload;
  /** Base reimbursement tracking payload with simulated row overlays applied. */
  tracking: import("./claim-reimbursement-tracking-ui-contract").ReimbursementTrackingUiPayload;
};

export function applySimulationToReimbursementTrackingPayload(args: {
  base: import("./claim-reimbursement-tracking-ui-contract").ReimbursementTrackingUiPayload;
  simulation: ClaimPilotSimulatedCompletionResult;
  simulationRunReference: string;
}): ReimbursementTrackingSimulationUiPayload {
  const bySubmission = new Map(
    args.simulation.simulated_money_lane_matrix.map((r) => [r.claim_submission_id, r]),
  );
  const filingBySubmission = new Map(
    args.simulation.simulated_manual_filing_input.entries.map((r) => [r.claim_submission_id, r]),
  );

  const previews = args.base.previews.map((row) => {
    const money = bySubmission.get(row.claim_submission_id);
    const filing = filingBySubmission.get(row.claim_submission_id);
    if (!money || !filing) return row;

    return {
      ...row,
      submission_status: "submitted",
      recovery_value: money.recovery_value,
      observed_reimbursement: null,
      financial_gap: null,
      future_amazon_case_id: filing.external_case_id,
      reimbursement_tracking_status: "filed_waiting_for_amazon" as const,
      not_submitted_to_amazon: true,
      money_warnings: [...row.money_warnings.filter((w) => !w.includes("COGS"))],
      detail_preview: {
        ...row.detail_preview,
        financial_gap_explanation:
          "Simulated: recovery value known; observed reimbursement pending (Unknown).",
        warnings: [
          ...row.detail_preview.warnings,
          "SIMULATION ONLY — not production filing or COGS",
        ],
      },
    };
  });

  const tracking = {
    ...args.base,
    preview_run_reference: `${args.base.preview_run_reference} + ${args.simulationRunReference}`,
    previews,
    read_only: true as const,
    not_submitted_to_amazon: true as const,
  };

  return {
    simulation_only: true,
    simulation_mode: true,
    simulation_banner: args.simulation.ui_demo_payload.banner,
    simulation_run_reference: args.simulationRunReference,
    base_preview_run_reference: args.base.preview_run_reference,
    ui_demo_payload: args.simulation.ui_demo_payload,
    tracking,
  };
}
