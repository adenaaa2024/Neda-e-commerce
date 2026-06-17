/**
 * Smoke — PHASE-CLAIM-PILOT-FINAL-SIMULATION-VERIFY-V1
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CLAIM_PILOT_FINAL_SIMULATION_VERIFY_V1,
  verifyFinalSimulationContractStatic,
} from "../lib/claims/submission/claim-pilot-final-simulation-verify-v1";

assert.ok(verifyFinalSimulationContractStatic());

const phaseScript = fs.readFileSync(
  path.join(process.cwd(), "scripts/phase-claim-pilot-final-simulation-verify-v1.ts"),
  "utf8",
);
assert.match(phaseScript, /final-simulation-verify/);
assert.match(phaseScript, /production_readiness_percent/);
assert.match(phaseScript, /SAFE_CLAIM_PILOT_SIMULATION_100_PERCENT/);

console.log(
  JSON.stringify({
    smoke: "pass",
    version: CLAIM_PILOT_FINAL_SIMULATION_VERIFY_V1,
    SAFE_FINAL_SIMULATION_CONTRACT: "ok",
  }),
);
