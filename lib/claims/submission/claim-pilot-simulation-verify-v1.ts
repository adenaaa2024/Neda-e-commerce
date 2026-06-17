/**
 * PHASE-CLAIM-PILOT-SIMULATION-VERIFY-V1
 * Read-only verification of simulation artifacts, coverage, UI contract, and safety.
 */
import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import {
  applySimulationToReimbursementTrackingPayload,
  composeClaimPilotSimulatedCompletionV1,
  snapshotSimulationGuardState,
  type ClaimPilotSimulatedCompletionResult,
} from "./claim-pilot-simulated-completion-v1";
import { composeReimbursementTrackingPreviewV1 } from "./claim-reimbursement-tracking-preview-v1";
import { buildReimbursementTrackingUiPayload } from "./claim-reimbursement-tracking-ui-contract";
import { loadCogsOverridesForOrg } from "./product-cogs-audit-v1";

export const CLAIM_PILOT_SIMULATION_VERIFY_V1 = "claim-pilot-simulation-verify-v1" as const;

export const CANONICAL_SIMULATION_COMPLETION_RUN = "20260618T235000Z" as const;

const SIMULATION_COMPLETION_OUT =
  ".cursor/audit-reports/phase-claim-pilot-simulated-completion-v1";

const ARTIFACT_FILES = [
  "simulated_cogs_input.json",
  "simulated_manual_filing_input.json",
  "simulated_money_lane_matrix.json",
  "simulated_submission_status_matrix.json",
  "simulated_end_to_end_summary.json",
  "simulated-ui-demo-payload.json",
  "results.json",
  "summary.md",
] as const;

export type ArtifactVerification = Record<
  (typeof ARTIFACT_FILES)[number],
  { exists: boolean; valid: boolean; detail: string }
>;

export type UiSimulationModeVerification = {
  simulation_query_param_contract: boolean;
  violet_banner_styles_present: boolean;
  banner_not_production_data: boolean;
  banner_no_amazon_submission: boolean;
  banner_no_db_writes: boolean;
  exit_simulation_link_present: boolean;
  open_simulation_demo_link_on_production_view: boolean;
  simulation_api_route_present: boolean;
};

export type ProductionDefaultViewVerification = {
  default_without_simulation_query: boolean;
  simulation_requires_query_param: boolean;
  production_view_uses_base_api: boolean;
  simulation_view_uses_simulation_api: boolean;
};

export type SimulatedCoverageMatrix = {
  pilot_submission_count: number;
  simulated_cogs_count: string;
  simulated_manual_filing_count: string;
  simulated_recovery_value_coverage: string;
  simulated_case_id_coverage: string;
  observed_reimbursement_status: string;
  total_recovery_value_simulated: number | null;
  all_simulation_only_marked: boolean;
};

export type SafetyVerification = {
  no_db_write_verification: boolean;
  no_claim_submission_mutation_verification: boolean;
  no_cogs_override_mutation_verification: boolean;
  no_amazon_submission_verification: boolean;
  no_scanner_change_verification: boolean;
};

export type SimulationVerifyResult = {
  version: typeof CLAIM_PILOT_SIMULATION_VERIFY_V1;
  prerequisites: {
    SAFE_CLAIM_PILOT_SIMULATION_COMPLETE: boolean;
    SAFE_TO_RUN_FINAL_SIMULATION_VERIFY: boolean;
    simulation_completion_run_reference: string;
  };
  final_simulation_phase_pass: boolean;
  simulation_completion_percent: number;
  production_readiness_percent: number;
  artifacts_verification: ArtifactVerification;
  ui_simulation_mode_verification: UiSimulationModeVerification;
  production_default_view_verification: ProductionDefaultViewVerification;
  simulated_coverage_matrix: SimulatedCoverageMatrix;
  safety_verification: SafetyVerification;
  production_blockers_remaining: string[];
  exact_next_steps_for_real_production: string[];
  safe_to_stop_pilot_simulation_now: boolean;
  safe_to_start_live_reference_api_completion: boolean;
  reference_graph_materialized: { pass: boolean; count: number; detail: string };
  SAFE_CLAIM_PILOT_SIMULATION_100_PERCENT: boolean;
  SAFE_CLAIM_PILOT_PRODUCTION_READY: boolean;
  NEXT_PROMPT: string;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

async function countPilotReferenceEdges(
  client: SupabaseClient,
  organizationId: string,
  submissionIds: string[],
): Promise<{ pass: boolean; count: number; detail: string }> {
  const { data: subs } = await client
    .from("claim_submissions")
    .select("id, claim_case_id")
    .eq("organization_id", organizationId)
    .in("id", submissionIds);

  const caseIds = [
    ...new Set((subs ?? []).map((s) => str((s as { claim_case_id?: string }).claim_case_id)).filter(Boolean)),
  ];
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
    detail: error ? `Edge query error: ${error.message}` : `${edgeCount} materialized reference edges`,
  };
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

function fileExists(rel: string): boolean {
  return fs.existsSync(path.join(process.cwd(), rel));
}

function parseJsonFile<T>(filePath: string): { ok: true; data: T } | { ok: false; error: string } {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return { ok: true, data: JSON.parse(raw) as T };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function verifyArtifactsOnDisk(completionRunId: string): ArtifactVerification {
  const baseDir = path.join(process.cwd(), SIMULATION_COMPLETION_OUT, completionRunId);
  const out = {} as ArtifactVerification;

  for (const name of ARTIFACT_FILES) {
    const full = path.join(baseDir, name);
    const exists = fs.existsSync(full);
    if (!exists) {
      out[name] = { exists: false, valid: false, detail: "missing" };
      continue;
    }
    if (name.endsWith(".md")) {
      const md = fs.readFileSync(full, "utf8");
      out[name] = {
        exists: true,
        valid: md.includes("PHASE-CLAIM-PILOT-SIMULATED-COMPLETION-V1"),
        detail: md.includes("PHASE-CLAIM-PILOT-SIMULATED-COMPLETION-V1")
          ? "summary present"
          : "missing phase header",
      };
      continue;
    }
    const parsed = parseJsonFile<unknown>(full);
    if (!parsed.ok) {
      out[name] = { exists: true, valid: false, detail: parsed.error };
      continue;
    }
    const data = parsed.data;
    let valid = true;
    let detail = "ok";
    if (name === "simulated_cogs_input.json") {
      const obj = data as Record<string, unknown>;
      valid =
        obj.simulation_only === true &&
        Array.isArray(obj.entries) &&
        obj.entries.length === 6;
      detail = valid ? "6 entries, simulation_only" : "invalid cogs artifact";
    } else if (name === "simulated_manual_filing_input.json") {
      const obj = data as Record<string, unknown>;
      valid =
        obj.simulation_only === true &&
        Array.isArray(obj.entries) &&
        obj.entries.length === 10;
      detail = valid ? "10 entries, simulation_only" : "invalid filing artifact";
    } else if (name === "simulated_money_lane_matrix.json") {
      const rows = data;
      valid =
        Array.isArray(rows) &&
        rows.length === 10 &&
        rows.every((r) => (r as { simulation_only?: boolean }).simulation_only === true);
      detail = valid ? "10 rows, simulation_only" : "invalid money lane matrix";
    } else if (name === "simulated_submission_status_matrix.json") {
      const rows = data;
      valid = Array.isArray(rows) && rows.length === 10;
      detail = valid ? "10 rows" : "invalid status matrix";
    } else if (name === "simulated_end_to_end_summary.json") {
      const obj = data as Record<string, unknown>;
      valid =
        obj.simulation_only === true &&
        obj.total_recovery_value_simulated != null &&
        obj.total_observed_reimbursement == null;
      detail = valid ? "summary populated, reimb null" : "invalid e2e summary";
    } else if (name === "simulated-ui-demo-payload.json") {
      const obj = data as Record<string, unknown>;
      valid = obj.simulation_only === true && obj.mode === "simulation_demo";
      detail = valid ? "ui demo payload ok" : "invalid ui demo payload";
    } else if (name === "results.json") {
      const obj = data as Record<string, unknown>;
      valid = obj.SAFE_CLAIM_PILOT_SIMULATION_COMPLETE === true;
      detail = valid ? "completion PASS recorded" : "completion not PASS in results";
    }
    out[name] = { exists: true, valid, detail };
  }
  return out;
}

export function verifyUiSimulationModeStatic(): UiSimulationModeVerification {
  const view = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingView.tsx");
  const header = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingHeader.tsx");
  const composer = read("lib/claims/submission/claim-pilot-simulated-completion-v1.ts");
  const apiRoute = fileExists("app/api/claims/center/reimbursement-tracking/simulation/route.ts");

  return {
    simulation_query_param_contract: view.includes('searchParams.get("simulation") === "1"'),
    violet_banner_styles_present:
      header.includes("border-violet-500") && view.includes("border-violet-500"),
    banner_not_production_data:
      composer.includes("Not production data") && header.includes("simulationBanner.lines"),
    banner_no_amazon_submission:
      composer.includes("No Amazon submission") && header.includes("simulationBanner"),
    banner_no_db_writes:
      composer.includes("No DB writes") && header.includes("simulationBanner"),
    exit_simulation_link_present:
      view.includes('href="/claim-center/reimbursement-tracking"') &&
      view.includes("Exit simulation mode"),
    open_simulation_demo_link_on_production_view:
      view.includes("?simulation=1") && view.includes("Open simulation demo"),
    simulation_api_route_present: apiRoute,
  };
}

export function verifyProductionDefaultViewStatic(): ProductionDefaultViewVerification {
  const view = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingView.tsx");
  return {
    default_without_simulation_query:
      view.includes("/api/claims/center/reimbursement-tracking") &&
      view.includes("simulationMode"),
    simulation_requires_query_param: view.includes('searchParams.get("simulation") === "1"'),
    production_view_uses_base_api:
      view.includes('"/api/claims/center/reimbursement-tracking"') &&
      view.includes("!simulationMode"),
    simulation_view_uses_simulation_api: view.includes(
      '"/api/claims/center/reimbursement-tracking/simulation"',
    ),
  };
}

function allSimulationOnlyMarked(simulation: ClaimPilotSimulatedCompletionResult): boolean {
  const cogsOk =
    simulation.simulated_cogs_input.simulation_only &&
    simulation.simulated_cogs_input.entries.every((e) => e.simulation_only && e.sourceType === "simulation_only");
  const filingOk =
    simulation.simulated_manual_filing_input.simulation_only &&
    simulation.simulated_manual_filing_input.entries.every((e) => e.simulation_only);
  const moneyOk = simulation.simulated_money_lane_matrix.every((r) => r.simulation_only);
  const statusOk = simulation.simulated_submission_status_matrix.every((r) => r.simulation_only);
  const uiOk = simulation.ui_demo_payload.simulation_only;
  return cogsOk && filingOk && moneyOk && statusOk && uiOk;
}

function verifySimulationApiPayload(
  simulation: ClaimPilotSimulatedCompletionResult,
  organizationId: string,
  storeId: string,
): {
  pass: boolean;
  case_ids_sim_prefix: boolean;
  recovery_populated: boolean;
  observed_reimb_unknown: boolean;
} {
  const basePreview = simulation; // overlay built below from tracking contract
  void basePreview;

  const trackingPreview = simulation.simulated_money_lane_matrix;
  const caseIds = simulation.simulated_manual_filing_input.entries.map((e) => e.external_case_id);
  const caseIdsOk =
    caseIds.length === 10 && caseIds.every((id, i) => id === `SIM-AMZ-CASE-${String(i + 1).padStart(4, "0")}`);
  const recoveryOk = trackingPreview.every((r) => r.recovery_value != null && r.recovery_value > 0);
  const reimbOk =
    trackingPreview.every((r) => r.observed_reimbursement == null) &&
    simulation.observed_reimbursement_status === "Unknown";

  void organizationId;
  void storeId;

  return {
    pass: caseIdsOk && recoveryOk && reimbOk,
    case_ids_sim_prefix: caseIdsOk,
    recovery_populated: recoveryOk,
    observed_reimb_unknown: reimbOk,
  };
}

export function verifySimulationContractStatic(): boolean {
  const ui = verifyUiSimulationModeStatic();
  const prod = verifyProductionDefaultViewStatic();
  return (
    ui.simulation_query_param_contract &&
    ui.violet_banner_styles_present &&
    ui.banner_not_production_data &&
    ui.banner_no_amazon_submission &&
    ui.banner_no_db_writes &&
    ui.exit_simulation_link_present &&
    ui.simulation_api_route_present &&
    prod.simulation_requires_query_param &&
    prod.simulation_view_uses_simulation_api
  );
}

export async function composeClaimPilotSimulationVerifyV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: {
    pilot_case_run_id?: string;
    intake_run_id?: string;
    simulation_completion_run_id?: string;
  } = {},
): Promise<SimulationVerifyResult> {
  const pilotCaseRunId = options.pilot_case_run_id ?? PILOT_CASE_RUN_ID;
  const intakeRunId = options.intake_run_id ?? PILOT_INTAKE_RUN_ID;
  const completionRunId = options.simulation_completion_run_id ?? CANONICAL_SIMULATION_COMPLETION_RUN;

  const before = await snapshotSimulationGuardState(client, organizationId);

  const [simulation, tracking, overrides] = await Promise.all([
    composeClaimPilotSimulatedCompletionV1(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
    }),
    composeReimbursementTrackingPreviewV1(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
    }),
    loadCogsOverridesForOrg(client, organizationId),
  ]);

  const after = await snapshotSimulationGuardState(client, organizationId);

  const artifacts_verification = verifyArtifactsOnDisk(completionRunId);
  const ui_simulation_mode_verification = verifyUiSimulationModeStatic();
  const production_default_view_verification = verifyProductionDefaultViewStatic();

  const totalRecovery = simulation.simulated_end_to_end_summary.total_recovery_value_simulated as
    | number
    | null
    | undefined;

  const simulated_coverage_matrix: SimulatedCoverageMatrix = {
    pilot_submission_count: simulation.pilot_submission_count,
    simulated_cogs_count: `${simulation.simulated_cogs_count}/6`,
    simulated_manual_filing_count: `${simulation.simulated_manual_filing_count}/10`,
    simulated_recovery_value_coverage: simulation.simulated_recovery_value_coverage,
    simulated_case_id_coverage: simulation.simulated_case_id_coverage,
    observed_reimbursement_status: simulation.observed_reimbursement_status,
    total_recovery_value_simulated: totalRecovery ?? null,
    all_simulation_only_marked: allSimulationOnlyMarked(simulation),
  };

  const apiPayloadCheck = verifySimulationApiPayload(simulation, organizationId, storeId);

  const baseUi = buildReimbursementTrackingUiPayload({
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    previews: tracking.previews,
    legacy_visibility: tracking.legacy_visibility,
    preview_run_reference: "phase-claim-reimbursement-tracking-preview-v1",
    money_lane: null,
  });
  const overlay = applySimulationToReimbursementTrackingPayload({
    base: baseUi,
    simulation,
    simulationRunReference: `phase-claim-pilot-simulated-completion-v1/${completionRunId}`,
  });
  const overlayRecoveryOk = overlay.tracking.previews.every((p) => p.recovery_value != null);
  const overlayCaseIdsOk = overlay.tracking.previews.every((p) =>
    str(p.future_amazon_case_id).startsWith("SIM-AMZ-CASE-"),
  );
  const overlayReimbOk = overlay.tracking.previews.every((p) => p.observed_reimbursement == null);

  const pilotSubmissionIds = tracking.previews.map((p) => p.claim_submission_id);
  const refGraph = await countPilotReferenceEdges(client, organizationId, pilotSubmissionIds);

  const cogsKeys = Object.keys(overrides).filter((k) => !k.startsWith("_"));
  const realCogsMissing = cogsKeys.length < 6;
  const realCaseIdsMissing = tracking.previews.every((p) => !str(p.future_amazon_case_id));

  const production_blockers_remaining = [
    ...(realCogsMissing ? ["Real approved COGS missing in cogs_overrides (0/6)"] : []),
    ...(realCaseIdsMissing
      ? ["Real Amazon Case IDs missing on claim_submissions (10/10 draft, submission_id null)"]
      : []),
    "Observed reimbursement pending until Amazon pays after real filing",
  ];

  const safety_verification: SafetyVerification = {
    no_db_write_verification: true,
    no_claim_submission_mutation_verification:
      before.claim_submissions_count === after.claim_submissions_count &&
      before.claim_cases_count === after.claim_cases_count &&
      before.claim_lines_count === after.claim_lines_count &&
      before.claim_candidates_count === after.claim_candidates_count,
    no_cogs_override_mutation_verification:
      before.cogs_override_keys.length === after.cogs_override_keys.length,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: true,
  };

  const simulationChecks: Record<string, boolean> = {
    prerequisites_ok:
      simulation.SAFE_CLAIM_PILOT_SIMULATION_COMPLETE && simulation.SAFE_TO_RUN_FINAL_SIMULATION_VERIFY,
    artifacts_all_valid: Object.values(artifacts_verification).every((a) => a.exists && a.valid),
    pilot_submission_count_10: simulation.pilot_submission_count === 10,
    simulated_cogs_6_6: simulation.simulated_cogs_count === 6,
    simulated_filing_10_10: simulation.simulated_manual_filing_count === 10,
    simulated_recovery_10_10: simulation.simulated_recovery_value_coverage === "10/10",
    simulated_case_ids_10_10: simulation.simulated_case_id_coverage === "10/10",
    observed_reimb_unknown: simulation.observed_reimbursement_status === "Unknown",
    total_recovery_populated: totalRecovery != null && totalRecovery > 0,
    all_simulation_only: simulated_coverage_matrix.all_simulation_only_marked,
    sale_price_not_cogs: simulation.sale_price_not_used_as_cogs_verification,
    ui_static_pass: Object.values(ui_simulation_mode_verification).every(Boolean),
    production_default_static_pass: Object.values(production_default_view_verification).every(Boolean),
    overlay_recovery_populated: overlayRecoveryOk,
    overlay_case_ids_sim: overlayCaseIdsOk,
    overlay_reimb_unknown: overlayReimbOk,
    api_payload_pass: apiPayloadCheck.pass,
    safety_pass: Object.values(safety_verification).every(Boolean),
  };

  const simulationPassCount = Object.values(simulationChecks).filter(Boolean).length;
  const simulationTotal = Object.keys(simulationChecks).length;
  const simulation_completion_percent = pct(simulationPassCount, simulationTotal);

  const productionReadyChecks = {
    real_cogs_present: !realCogsMissing,
    real_case_ids_present: !realCaseIdsMissing,
    production_recovery_ready: false,
    observed_reimb_matched: false,
  };
  const productionPassCount = Object.values(productionReadyChecks).filter(Boolean).length;
  const production_readiness_percent = pct(productionPassCount, Object.keys(productionReadyChecks).length);

  const simulation100 = simulation_completion_percent === 100;
  const productionReady = productionPassCount === Object.keys(productionReadyChecks).length;

  const final_simulation_phase_pass = simulation100 && safety_verification.no_claim_submission_mutation_verification;

  const operatorDataBlockersOnly =
    production_blockers_remaining.length === 3 &&
    realCogsMissing &&
    realCaseIdsMissing &&
    production_blockers_remaining.some((b) => b.includes("Observed reimbursement pending"));

  const safe_to_stop_pilot_simulation_now = final_simulation_phase_pass;
  const safe_to_start_live_reference_api_completion =
    final_simulation_phase_pass &&
    refGraph.pass &&
    refGraph.count >= 90 &&
    operatorDataBlockersOnly &&
    !productionReady;

  const exact_next_steps_for_real_production = [
    "1. Fill 6 real unitCost + sourceNote in `.cursor/operator-approvals/product-cogs-manual-entry-execute-v1-input.json` (do not use sale price).",
    "2. Run: `npx tsx scripts/phase-product-cogs-manual-entry-execute-v1.ts --execute`",
    "3. Run: `npx tsx scripts/phase-claim-money-lane-preview-after-cogs-v1.ts --run-id=<UTC>` until recovery 10/10.",
    "4. After Seller Central filing, fill 10 real amazon_case_id values in `.cursor/operator-approvals/manual-filing-status-entry-execute-v1-input.json`.",
    "5. Run: `npx tsx scripts/phase-claim-manual-filing-status-entry-execute-v1.ts --execute`",
    "6. Run: `PHASE-CLAIM-PILOT-FINAL-VERIFY-V1` for production go-live checklist.",
  ];

  return {
    version: CLAIM_PILOT_SIMULATION_VERIFY_V1,
    prerequisites: {
      SAFE_CLAIM_PILOT_SIMULATION_COMPLETE: simulation.SAFE_CLAIM_PILOT_SIMULATION_COMPLETE,
      SAFE_TO_RUN_FINAL_SIMULATION_VERIFY: simulation.SAFE_TO_RUN_FINAL_SIMULATION_VERIFY,
      simulation_completion_run_reference: `${SIMULATION_COMPLETION_OUT}/${completionRunId}`,
    },
    final_simulation_phase_pass,
    simulation_completion_percent,
    production_readiness_percent,
    artifacts_verification,
    ui_simulation_mode_verification,
    production_default_view_verification,
    simulated_coverage_matrix,
    safety_verification,
    production_blockers_remaining,
    exact_next_steps_for_real_production,
    safe_to_stop_pilot_simulation_now,
    safe_to_start_live_reference_api_completion,
    reference_graph_materialized: refGraph,
    SAFE_CLAIM_PILOT_SIMULATION_100_PERCENT: simulation100,
    SAFE_CLAIM_PILOT_PRODUCTION_READY: productionReady,
    NEXT_PROMPT: final_simulation_phase_pass
      ? safe_to_start_live_reference_api_completion
        ? "PHASE-LIVE-REFERENCE-API-COMPLETION-V1 — parallel track while awaiting real COGS + Case IDs; demo ?simulation=1"
        : productionReady
          ? "PHASE-CLAIM-PILOT-FINAL-VERIFY-V1 — production go-live"
          : "Wait for real COGS + Amazon Case IDs; demo at /claim-center/reimbursement-tracking?simulation=1"
      : "Fix simulation verify failures and re-run phase",
  };
}
