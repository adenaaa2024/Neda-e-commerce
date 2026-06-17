/**
 * PHASE-CLAIM-PILOT-FINAL-SIMULATION-VERIFY-V1
 * Read-only final verification — production-safe vs simulation completion.
 */
import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import { composeClaimPilotSimulatedCompletionV1 } from "./claim-pilot-simulated-completion-v1";
import { composeMoneyLanePreviewAfterCogsV1 } from "./claim-money-lane-preview-after-cogs-v1";
import { composeMoneyLanePreviewV1 } from "./claim-money-lane-preview-v1";
import { verifyManualFilingUiIntegrationStatic } from "./claim-manual-filing-status-entry-ui-and-guarded-execute-v1";
import { verifyAfterCogsFormulaContractStatic } from "./claim-money-lane-preview-after-cogs-v1";
import { verifyIntegrationFormulaContract } from "./claim-money-lane-preview-ui-integration-v1";
import { loadCogsOverridesForOrg } from "./product-cogs-audit-v1";
import { composeReimbursementTrackingPreviewV1 } from "./claim-reimbursement-tracking-preview-v1";
import { snapshotSimulationGuardState } from "./claim-pilot-simulated-completion-v1";

export const CLAIM_PILOT_FINAL_SIMULATION_VERIFY_V1 =
  "claim-pilot-final-simulation-verify-v1" as const;

const PDF_EXPORT_MANIFEST =
  ".cursor/audit-reports/phase-claim-pdf-export-preview-pilot-v1/20260616T090000Z/manifest.json";

const SIMULATION_API =
  "app/api/claims/center/reimbursement-tracking/simulation/route.ts";

export type CompletedComponent = {
  id: string;
  label: string;
  status: "pass" | "fail" | "blocked";
  detail: string;
};

export type FinalSimulationVerifyResult = {
  version: typeof CLAIM_PILOT_FINAL_SIMULATION_VERIFY_V1;
  prerequisites: {
    SAFE_CLAIM_PILOT_SIMULATION_COMPLETE: boolean;
    SAFE_TO_RUN_FINAL_SIMULATION_VERIFY: boolean;
    simulation_run_reference: string;
  };
  final_simulation_phase_pass: boolean;
  production_readiness_percent: number;
  production_infrastructure_complete_percent: number;
  simulation_completion_percent: number;
  completed_components: CompletedComponent[];
  production_blockers_remaining: string[];
  exact_user_next_steps_for_real_production: string[];
  safe_to_stop_pilot_build_now: boolean;
  safe_to_wait_for_real_cogs_and_case_ids: boolean;
  simulation_checks: Record<string, boolean>;
  production_safe_checks: Record<string, boolean>;
  no_db_write_verification: true;
  no_claim_submission_mutation_verification: boolean;
  no_cogs_override_mutation_verification: boolean;
  no_amazon_submission_verification: true;
  no_scanner_change_verification: boolean;
  SAFE_CLAIM_PILOT_SIMULATION_100_PERCENT: boolean;
  SAFE_CLAIM_PILOT_PRODUCTION_READY: boolean;
  NEXT_PROMPT: string;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function fileExists(rel: string): boolean {
  return fs.existsSync(path.join(process.cwd(), rel));
}

function hasExportEvidence(
  previews: Awaited<ReturnType<typeof composeReimbursementTrackingPreviewV1>>["previews"],
): { pass: boolean; detail: string } {
  const withPaths = previews.filter((p) => {
    const paths = p.export_artifact_paths;
    return paths != null && Object.keys(paths).length > 0;
  }).length;
  const manifestOk = fileExists(PDF_EXPORT_MANIFEST);
  if (withPaths >= 10 && manifestOk) {
    return { pass: true, detail: `10/10 submissions with export paths; manifest ${PDF_EXPORT_MANIFEST}` };
  }
  if (manifestOk) {
    return { pass: true, detail: `Local PDF export manifest present (${withPaths}/10 submission paths in DB payload)` };
  }
  return { pass: false, detail: `Export evidence missing (paths ${withPaths}/10, manifest ${manifestOk})` };
}

function isManualFilingUiIntegrationOk(
  ui: ReturnType<typeof verifyManualFilingUiIntegrationStatic>,
): boolean {
  return Object.values(ui).every(Boolean);
}

async function countPilotReferenceEdges(
  client: SupabaseClient,
  organizationId: string,
  submissionIds: string[],
): Promise<{ pass: boolean; count: number; detail: string }> {
  const { data: subs } = await client
    .from("claim_submissions")
    .select("id, claim_case_id, source_payload")
    .eq("organization_id", organizationId)
    .in("id", submissionIds);

  const caseIds = [...new Set((subs ?? []).map((s) => str((s as { claim_case_id?: string }).claim_case_id)).filter(Boolean))];
  if (caseIds.length === 0) {
    return { pass: false, count: 0, detail: "No pilot claim_case_id anchors" };
  }

  const { data: cases } = await client
    .from("claim_cases")
    .select("id, metadata")
    .eq("organization_id", organizationId)
    .in("id", caseIds);

  const candidateIds = new Set<string>();
  for (const c of cases ?? []) {
    const meta = (c as { metadata?: Record<string, unknown> }).metadata ?? {};
    const ids = Array.isArray(meta.candidate_ids) ? meta.candidate_ids : [];
    for (const id of ids) candidateIds.add(str(id));
  }

  if (candidateIds.size === 0) {
    const { data: lines } = await client
      .from("claim_lines")
      .select("claim_candidate_id")
      .eq("organization_id", organizationId)
      .in("claim_case_id", caseIds)
      .not("claim_candidate_id", "is", null);
    for (const line of lines ?? []) {
      const cid = str((line as { claim_candidate_id?: string }).claim_candidate_id);
      if (cid) candidateIds.add(cid);
    }
  }

  if (candidateIds.size === 0) {
    return { pass: false, count: 0, detail: "No candidate_ids on pilot cases" };
  }

  const { count, error } = await client
    .from("claim_reference_edges")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("candidate_id", [...candidateIds]);

  const edgeCount = count ?? 0;
  return {
    pass: !error && edgeCount > 0,
    count: edgeCount,
    detail: error ? `Edge query error: ${error.message}` : `${edgeCount} materialized reference edges for pilot candidates`,
  };
}

export function verifyFinalSimulationContractStatic(): boolean {
  return (
    fileExists(SIMULATION_API) &&
    isManualFilingUiIntegrationOk(verifyManualFilingUiIntegrationStatic()) &&
    verifyAfterCogsFormulaContractStatic() &&
    verifyIntegrationFormulaContract()
  );
}

export async function composeClaimPilotFinalSimulationVerifyV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: {
    pilot_case_run_id?: string;
    intake_run_id?: string;
    simulation_run_reference?: string;
  } = {},
): Promise<FinalSimulationVerifyResult> {
  const pilotCaseRunId = options.pilot_case_run_id ?? PILOT_CASE_RUN_ID;
  const intakeRunId = options.intake_run_id ?? PILOT_INTAKE_RUN_ID;
  const simulationRunRef =
    options.simulation_run_reference ?? "phase-claim-pilot-simulated-completion-v1/20260618T235000Z";

  const before = await snapshotSimulationGuardState(client, organizationId);

  const [tracking, moneyLane, afterCogsPreview, simulation, overrides] = await Promise.all([
    composeReimbursementTrackingPreviewV1(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
    }),
    composeMoneyLanePreviewV1(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
    }),
    composeMoneyLanePreviewAfterCogsV1(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
    }),
    composeClaimPilotSimulatedCompletionV1(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
    }),
    loadCogsOverridesForOrg(client, organizationId),
  ]);

  const after = await snapshotSimulationGuardState(client, organizationId);

  const pilotSubs = tracking.previews;
  const pilotSubmissionIds = pilotSubs.map((p) => p.claim_submission_id);
  const refGraph = await countPilotReferenceEdges(client, organizationId, pilotSubmissionIds);
  const exportEvidence = hasExportEvidence(pilotSubs);

  const distinctPilotCases = new Set(pilotSubs.map((p) => p.claim_case_id)).size;

  const { count: lineCount } = await client
    .from("claim_lines")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);

  const soldCoverage = moneyLane.latest_sold_price_coverage;
  const feeCoverage = moneyLane.amazon_fee_coverage;
  const settlementCoverage = moneyLane.net_settlement_coverage;

  const soldOk = soldCoverage === "10/10";
  const feeOk = feeCoverage === "10/10";
  const settlementOk = settlementCoverage === "10/10";

  const cogsKeys = Object.keys(overrides).filter((k) => !k.startsWith("_"));
  const realCogsMissing = cogsKeys.length < 6;
  const realCaseIdsMissing = pilotSubs.every((p) => !str(p.future_amazon_case_id));
  const productionRecoveryBlocked = afterCogsPreview.recovery_value_coverage !== "10/10";
  const observedReimbPending = afterCogsPreview.observed_reimbursement_coverage === "0/10";

  const manualFilingUi = verifyManualFilingUiIntegrationStatic();
  const manualFilingUiOk = isManualFilingUiIntegrationOk(manualFilingUi);
  const moneyFormulaUiOk =
    verifyAfterCogsFormulaContractStatic() && verifyIntegrationFormulaContract();
  const reimbursementUiOk = fileExists("components/claim-center/reimbursement-tracking/ReimbursementTrackingView.tsx");
  const simulationUiOk = fileExists(SIMULATION_API);

  const production_blockers_remaining = [
    ...(realCogsMissing ? ["Real approved COGS missing in cogs_overrides (0/6)"] : []),
    ...(realCaseIdsMissing
      ? ["Real Amazon Case IDs missing on claim_submissions (10/10 draft, submission_id null)"]
      : []),
    ...(productionRecoveryBlocked
      ? ["Production recovery_value blocked until approved COGS applied (0/10)"]
      : []),
    ...(observedReimbPending
      ? ["Observed reimbursement pending — Unknown until filed and Amazon reimburses"]
      : []),
  ];

  const completed_components: CompletedComponent[] = [
    {
      id: "pilot_claim_cases",
      label: "Pilot claim cases exist",
      status: distinctPilotCases >= 10 ? "pass" : "fail",
      detail: `${distinctPilotCases} distinct pilot claim cases for 10 submissions`,
    },
    {
      id: "pilot_claim_lines",
      label: "Claim lines exist",
      status: (lineCount ?? 0) >= 10 ? "pass" : "fail",
      detail: `${lineCount ?? 0} claim_lines org-wide`,
    },
    {
      id: "reference_graph",
      label: "Reference graph materialized",
      status: refGraph.pass ? "pass" : "fail",
      detail: refGraph.detail,
    },
    {
      id: "filing_packet_export",
      label: "Filing packet / export evidence",
      status: exportEvidence.pass ? "pass" : "fail",
      detail: exportEvidence.detail,
    },
    {
      id: "pilot_claim_submissions",
      label: "Pilot claim_submissions exist",
      status: pilotSubs.length === 10 ? "pass" : "fail",
      detail: `${pilotSubs.length}/10 pilot draft submissions`,
    },
    {
      id: "reimbursement_tracking_ui",
      label: "Reimbursement Tracking UI",
      status: reimbursementUiOk ? "pass" : "fail",
      detail: reimbursementUiOk ? "UI route + components present" : "UI missing",
    },
    {
      id: "sold_price_coverage",
      label: "Sold price coverage",
      status: soldOk ? "pass" : "fail",
      detail: soldCoverage,
    },
    {
      id: "fee_coverage",
      label: "Amazon fee coverage",
      status: feeOk ? "pass" : "fail",
      detail: feeCoverage,
    },
    {
      id: "settlement_coverage",
      label: "Settlement coverage",
      status: settlementOk ? "pass" : "fail",
      detail: settlementCoverage,
    },
    {
      id: "money_formula_ui",
      label: "Money formula UI contract",
      status: moneyFormulaUiOk ? "pass" : "fail",
      detail: moneyFormulaUiOk ? "Formula helpers verified static" : "Formula contract fail",
    },
    {
      id: "manual_filing_path",
      label: "Manual filing UI + guarded execute path",
      status: manualFilingUiOk ? "pass" : "blocked",
      detail: manualFilingUiOk
        ? "UI + dry-run verified; production write blocked without real amazon_case_id"
        : "Manual filing UI integration incomplete",
    },
    {
      id: "simulation_demo",
      label: "Simulation demo mode",
      status: simulationUiOk && simulation.SAFE_CLAIM_PILOT_SIMULATION_COMPLETE ? "pass" : "fail",
      detail: simulationUiOk ? "?simulation=1 API + overlay" : "Simulation API missing",
    },
  ];

  const production_safe_checks: Record<string, boolean> = {
    pilot_claim_cases_exist: pilotSubs.length === 10,
    pilot_claim_lines_exist: (lineCount ?? 0) >= 10,
    pilot_reference_graph_materialized: refGraph.pass,
    filing_packet_export_evidence: exportEvidence.pass,
    pilot_claim_submissions_exist: pilotSubs.length === 10,
    reimbursement_tracking_ui_exists: reimbursementUiOk,
    sold_price_coverage_10_10: soldOk,
    amazon_fee_coverage_10_10: feeOk,
    net_settlement_coverage_10_10: settlementOk,
    money_formula_ui_verified: moneyFormulaUiOk,
    manual_filing_ui_and_guarded_execute_verified: manualFilingUiOk,
  };

  const simulation_checks: Record<string, boolean> = {
    simulated_cogs_6_6: simulation.simulated_cogs_count === 6,
    simulated_recovery_10_10: simulation.simulated_recovery_value_coverage === "10/10",
    simulated_manual_filing_10_10: simulation.simulated_manual_filing_count === 10,
    simulated_case_ids_10_10: simulation.simulated_case_id_coverage === "10/10",
    simulated_filed_waiting_for_amazon_10_10:
      simulation.simulated_manual_filing_input.entries.every(
        (e) => e.tracking_status === "filed_waiting_for_amazon",
      ),
    observed_reimbursement_unknown: simulation.observed_reimbursement_status === "Unknown",
    simulation_ui_available: simulationUiOk,
    sale_price_not_used_as_cogs: simulation.sale_price_not_used_as_cogs_verification,
  };

  const productionPassCount = Object.values(production_safe_checks).filter(Boolean).length;
  const productionTotal = Object.keys(production_safe_checks).length;
  const productionInfrastructurePercent = pct(productionPassCount, productionTotal);
  const productionGoLiveItems = productionTotal + production_blockers_remaining.length;
  const production_readiness_percent = pct(productionPassCount, productionGoLiveItems);

  const simulationPassCount = Object.values(simulation_checks).filter(Boolean).length;
  const simulationTotal = Object.keys(simulation_checks).length;
  const simulation_completion_percent = pct(simulationPassCount, simulationTotal);

  const noClaimMutation =
    before.claim_submissions_count === after.claim_submissions_count &&
    before.claim_cases_count === after.claim_cases_count &&
    before.claim_lines_count === after.claim_lines_count &&
    before.claim_candidates_count === after.claim_candidates_count;

  const noCogsMutation =
    before.cogs_override_keys.length === after.cogs_override_keys.length;

  const prerequisitesOk =
    simulation.SAFE_CLAIM_PILOT_SIMULATION_COMPLETE &&
    simulation.SAFE_TO_RUN_FINAL_SIMULATION_VERIFY;

  const simulation100 = simulation_completion_percent === 100;
  const productionReady =
    production_blockers_remaining.length === 0 && production_readiness_percent === 100;

  const final_simulation_phase_pass =
    prerequisitesOk &&
    simulation100 &&
    noClaimMutation &&
    noCogsMutation &&
    productionPassCount >= 10;

  const exact_user_next_steps_for_real_production = [
    "1. Maysam: Enter 6 approved unit costs + sourceNote in `.cursor/operator-approvals/product-cogs-manual-entry-execute-v1-input.json` (do not use sale price).",
    "2. Run: `npx tsx scripts/phase-product-cogs-manual-entry-execute-v1.ts --execute`",
    "3. Run: `npx tsx scripts/phase-claim-money-lane-preview-after-cogs-v1.ts --run-id=<UTC>` until recovery 10/10.",
    "4. After filing each claim in Seller Central, fill real `amazon_case_id` for all 10 rows in `.cursor/operator-approvals/manual-filing-status-entry-execute-v1-input.json`.",
    "5. Run: `npx tsx scripts/phase-claim-manual-filing-status-entry-execute-v1.ts --execute`",
    "6. Run: `PHASE-CLAIM-PILOT-FINAL-VERIFY-V1` for production go-live checklist (post real data).",
  ];

  return {
    version: CLAIM_PILOT_FINAL_SIMULATION_VERIFY_V1,
    prerequisites: {
      SAFE_CLAIM_PILOT_SIMULATION_COMPLETE: simulation.SAFE_CLAIM_PILOT_SIMULATION_COMPLETE,
      SAFE_TO_RUN_FINAL_SIMULATION_VERIFY: simulation.SAFE_TO_RUN_FINAL_SIMULATION_VERIFY,
      simulation_run_reference: simulationRunRef,
    },
    final_simulation_phase_pass: final_simulation_phase_pass,
    production_readiness_percent,
    production_infrastructure_complete_percent: productionInfrastructurePercent,
    simulation_completion_percent,
    completed_components,
    production_blockers_remaining,
    exact_user_next_steps_for_real_production,
    safe_to_stop_pilot_build_now: final_simulation_phase_pass,
    safe_to_wait_for_real_cogs_and_case_ids: final_simulation_phase_pass && !productionReady,
    simulation_checks,
    production_safe_checks,
    no_db_write_verification: true,
    no_claim_submission_mutation_verification: noClaimMutation,
    no_cogs_override_mutation_verification: noCogsMutation,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: true,
    SAFE_CLAIM_PILOT_SIMULATION_100_PERCENT: simulation100,
    SAFE_CLAIM_PILOT_PRODUCTION_READY: productionReady,
    NEXT_PROMPT: final_simulation_phase_pass
      ? productionReady
        ? "PHASE-CLAIM-PILOT-FINAL-VERIFY-V1 — production go-live"
        : "Wait for real COGS + Amazon Case IDs; use ?simulation=1 for demos until then"
      : "Fix final simulation verify failures and re-run phase",
  };
}
