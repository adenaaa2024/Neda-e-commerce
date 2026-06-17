/**
 * Smoke — PHASE-CLAIM-PILOT-SIMULATED-COMPLETION-V1
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CLAIM_PILOT_SIMULATED_COMPLETION_V1,
  SIMULATED_PILOT_COGS_UNIT_COSTS_V1,
  verifySimulationContractStatic,
} from "../lib/claims/submission/claim-pilot-simulated-completion-v1";

assert.ok(verifySimulationContractStatic());
assert.equal(Object.keys(SIMULATED_PILOT_COGS_UNIT_COSTS_V1).length, 6);
assert.notEqual(SIMULATED_PILOT_COGS_UNIT_COSTS_V1.X004WJ8OE5!.unitCost, 22.99);

const phaseScript = fs.readFileSync(
  path.join(process.cwd(), "scripts/phase-claim-pilot-simulated-completion-v1.ts"),
  "utf8",
);
assert.match(phaseScript, /simulation-only/);
assert.match(phaseScript, /simulated_cogs_input\.json/);
assert.match(phaseScript, /no_cogs_override_mutation_verification/);

const simApi = path.join(
  process.cwd(),
  "app/api/claims/center/reimbursement-tracking/simulation/route.ts",
);
assert.ok(fs.existsSync(simApi), "simulation API route must exist");

console.log(
  JSON.stringify({
    smoke: "pass",
    version: CLAIM_PILOT_SIMULATED_COMPLETION_V1,
    SAFE_SIMULATION_CONTRACT: "ok",
  }),
);
