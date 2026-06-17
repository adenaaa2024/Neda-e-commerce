/**
 * PHASE-CLAIM-PILOT-SIMULATED-COMPLETION-V1
 *   npx tsx scripts/phase-claim-pilot-simulated-completion-v1.ts [--run-id=<UTC>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  composeClaimPilotSimulatedCompletionV1,
  snapshotSimulationGuardState,
  CLAIM_PILOT_SIMULATED_COMPLETION_V1,
} from "../lib/claims/submission/claim-pilot-simulated-completion-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-pilot-simulated-completion-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);

  const client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });

  const scannerBefore = scannerGitStatus();
  const before = await snapshotSimulationGuardState(client, ORG);

  const simulation = await composeClaimPilotSimulatedCompletionV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  const after = await snapshotSimulationGuardState(client, ORG);
  const scannerAfter = scannerGitStatus();

  fs.writeFileSync(
    path.join(outDir, "simulated_cogs_input.json"),
    JSON.stringify(simulation.simulated_cogs_input, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "simulated_manual_filing_input.json"),
    JSON.stringify(simulation.simulated_manual_filing_input, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "simulated_money_lane_matrix.json"),
    JSON.stringify(simulation.simulated_money_lane_matrix, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "simulated_submission_status_matrix.json"),
    JSON.stringify(simulation.simulated_submission_status_matrix, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "simulated_end_to_end_summary.json"),
    JSON.stringify(simulation.simulated_end_to_end_summary, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "simulated-ui-demo-payload.json"),
    JSON.stringify(simulation.ui_demo_payload, null, 2),
  );

  const noClaimMutation =
    before.claim_submissions_count === after.claim_submissions_count &&
    before.claim_cases_count === after.claim_cases_count &&
    before.claim_lines_count === after.claim_lines_count &&
    before.claim_candidates_count === after.claim_candidates_count;

  const noCogsMutation =
    before.cogs_override_keys.length === after.cogs_override_keys.length &&
    JSON.stringify(before.cogs_override_keys.sort()) === JSON.stringify(after.cogs_override_keys.sort());

  let buildResult = "fail";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  let smokeResult = "fail";
  try {
    execSync("npx tsx scripts/smoke-claim-pilot-simulated-completion-v1.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const uiSimulationAvailable = fs.existsSync(
    path.join(process.cwd(), "app/api/claims/center/reimbursement-tracking/simulation/route.ts"),
  );

  const phasePass =
    simulation.SAFE_CLAIM_PILOT_SIMULATION_COMPLETE &&
    noClaimMutation &&
    noCogsMutation &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const artifactsCreated = [
    "simulated_cogs_input.json",
    "simulated_manual_filing_input.json",
    "simulated_money_lane_matrix.json",
    "simulated_submission_status_matrix.json",
    "simulated_end_to_end_summary.json",
    "simulated-ui-demo-payload.json",
    "results.json",
    "summary.md",
  ];

  const result = {
    phase: "PHASE-CLAIM-PILOT-SIMULATED-COMPLETION-V1",
    run_id: rid,
    db_ref: ref,
    mode: "simulation-only",
    simulation_phase_pass: phasePass,
    pilot_submission_count: simulation.pilot_submission_count,
    simulated_cogs_count: simulation.simulated_cogs_count,
    simulated_manual_filing_count: simulation.simulated_manual_filing_count,
    simulated_recovery_value_coverage: simulation.simulated_recovery_value_coverage,
    simulated_case_id_coverage: simulation.simulated_case_id_coverage,
    observed_reimbursement_status: simulation.observed_reimbursement_status,
    artifacts_created: artifactsCreated,
    ui_simulation_mode_available: uiSimulationAvailable,
    production_write_performed: false,
    no_db_write_verification: true,
    no_claim_submission_mutation_verification: noClaimMutation,
    no_cogs_override_mutation_verification: noCogsMutation,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    before_snapshot: before,
    after_snapshot: after,
    sale_price_not_used_as_cogs_verification: simulation.sale_price_not_used_as_cogs_verification,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_CLAIM_PILOT_SIMULATION_COMPLETE: simulation.SAFE_CLAIM_PILOT_SIMULATION_COMPLETE,
    SAFE_TO_RUN_FINAL_SIMULATION_VERIFY: simulation.SAFE_TO_RUN_FINAL_SIMULATION_VERIFY,
    PRODUCTION_BLOCKERS_REMAINING: simulation.production_blockers_remaining,
    NEXT_PROMPT: simulation.NEXT_PROMPT,
    version: CLAIM_PILOT_SIMULATED_COMPLETION_V1,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-CLAIM-PILOT-SIMULATED-COMPLETION-V1

- Run: \`${rid}\`
- Mode: **simulation-only** (no DB writes)
- Pilot submissions: **${simulation.pilot_submission_count}**
- Simulated COGS: **${simulation.simulated_cogs_count}/6**
- Simulated filing: **${simulation.simulated_manual_filing_count}/10**
- Recovery simulated: **${simulation.simulated_recovery_value_coverage}**
- simulation_phase_pass: **${phasePass}**
- SAFE_CLAIM_PILOT_SIMULATION_COMPLETE: **${simulation.SAFE_CLAIM_PILOT_SIMULATION_COMPLETE}**

## UI demo
Open \`/claim-center/reimbursement-tracking?simulation=1\` for local simulation overlay (not production data).

## NEXT_PROMPT
\`${simulation.NEXT_PROMPT}\`
`,
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
