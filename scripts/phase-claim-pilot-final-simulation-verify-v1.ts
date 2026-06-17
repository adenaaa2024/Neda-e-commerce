/**
 * PHASE-CLAIM-PILOT-FINAL-SIMULATION-VERIFY-V1
 *   npx tsx scripts/phase-claim-pilot-final-simulation-verify-v1.ts [--run-id=<UTC>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  CLAIM_PILOT_FINAL_SIMULATION_VERIFY_V1,
  composeClaimPilotFinalSimulationVerifyV1,
} from "../lib/claims/submission/claim-pilot-final-simulation-verify-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-pilot-final-simulation-verify-v1";
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

  const verify = await composeClaimPilotFinalSimulationVerifyV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    simulation_run_reference: "phase-claim-pilot-simulated-completion-v1/20260618T235000Z",
  });

  const scannerAfter = scannerGitStatus();

  let buildResult = "fail";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  let smokeResult = "fail";
  try {
    execSync("npx tsx scripts/smoke-claim-pilot-final-simulation-verify-v1.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const phasePass =
    verify.final_simulation_phase_pass && buildResult === "pass" && smokeResult === "pass";

  const result = {
    phase: "PHASE-CLAIM-PILOT-FINAL-SIMULATION-VERIFY-V1",
    run_id: rid,
    db_ref: ref,
    mode: "final-simulation-verify-read-only",
    ...verify,
    build_result: buildResult,
    smoke_result: smokeResult,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    phase_pass: phasePass,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "completed-components.json"),
    JSON.stringify(verify.completed_components, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-CLAIM-PILOT-FINAL-SIMULATION-VERIFY-V1

- Run: \`${rid}\`
- Mode: **read-only verification**
- final_simulation_phase_pass: **${verify.final_simulation_phase_pass}**
- simulation_completion_percent: **${verify.simulation_completion_percent}%**
- production_readiness_percent: **${verify.production_readiness_percent}%** (go-live; blockers included)
- production_infrastructure_complete_percent: **${verify.production_infrastructure_complete_percent}%**
- SAFE_CLAIM_PILOT_SIMULATION_100_PERCENT: **${verify.SAFE_CLAIM_PILOT_SIMULATION_100_PERCENT}**
- SAFE_CLAIM_PILOT_PRODUCTION_READY: **${verify.SAFE_CLAIM_PILOT_PRODUCTION_READY}**
- safe_to_stop_pilot_build_now: **${verify.safe_to_stop_pilot_build_now}**

## Production blockers
${verify.production_blockers_remaining.map((b) => `- ${b}`).join("\n")}

## NEXT_PROMPT
\`${verify.NEXT_PROMPT}\`
`,
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
