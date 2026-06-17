/**
 * Smoke — PHASE-CLAIM-MONEY-LANE-PREVIEW-AFTER-COGS-V1
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CLAIM_MONEY_LANE_PREVIEW_AFTER_COGS_V1,
  verifyAfterCogsFormulaContractStatic,
} from "../lib/claims/submission/claim-money-lane-preview-after-cogs-v1";
import { MONEY_LANE_INTEGRATION_FORMULA_CONTRACT } from "../lib/claims/submission/claim-money-lane-preview-ui-integration-v1";

assert.ok(verifyAfterCogsFormulaContractStatic());
assert.ok(MONEY_LANE_INTEGRATION_FORMULA_CONTRACT.recovery_value.includes("clean_quantity"));
assert.ok(MONEY_LANE_INTEGRATION_FORMULA_CONTRACT.open_recovery_gap.includes("Unknown"));

const phaseScript = fs.readFileSync(
  path.join(process.cwd(), "scripts/phase-claim-money-lane-preview-after-cogs-v1.ts"),
  "utf8",
);
assert.match(phaseScript, /phase-claim-money-lane-preview-after-cogs-v1/);
assert.match(phaseScript, /composeMoneyLanePreviewAfterCogsV1/);
assert.match(phaseScript, /no_db_write_verification/);
assert.match(phaseScript, /SAFE_TO_EXECUTE_MANUAL_FILING_STATUS_ENTRY/);

console.log(
  JSON.stringify({
    smoke: "pass",
    version: CLAIM_MONEY_LANE_PREVIEW_AFTER_COGS_V1,
    SAFE_AFTER_COGS_CONTRACT: "ok",
  }),
);
