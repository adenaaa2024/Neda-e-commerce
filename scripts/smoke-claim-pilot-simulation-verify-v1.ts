/**
 * Smoke — PHASE-CLAIM-PILOT-SIMULATION-VERIFY-V1
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CLAIM_PILOT_SIMULATION_VERIFY_V1,
  verifySimulationContractStatic,
  verifyUiSimulationModeStatic,
} from "../lib/claims/submission/claim-pilot-simulation-verify-v1";

assert.ok(verifySimulationContractStatic());

const ui = verifyUiSimulationModeStatic();
assert.ok(ui.violet_banner_styles_present);
assert.ok(ui.banner_not_production_data);
assert.ok(ui.exit_simulation_link_present);

const phaseScript = fs.readFileSync(
  path.join(process.cwd(), "scripts/phase-claim-pilot-simulation-verify-v1.ts"),
  "utf8",
);
assert.match(phaseScript, /simulation-verify/);
assert.match(phaseScript, /artifacts_verification/);
assert.match(phaseScript, /SAFE_CLAIM_PILOT_SIMULATION_100_PERCENT/);

console.log(
  JSON.stringify({
    smoke: "pass",
    version: CLAIM_PILOT_SIMULATION_VERIFY_V1,
    SAFE_SIMULATION_VERIFY_CONTRACT: "ok",
  }),
);
