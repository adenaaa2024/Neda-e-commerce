/**
 * Smoke — PHASE-PRODUCT-COGS-UI-INPUT-RECONCILIATION-V1
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  PRODUCT_COGS_UI_INPUT_RECONCILIATION_V1,
  verifyCogsReconciliationContractStatic,
} from "../lib/claims/submission/product-cogs-ui-input-reconciliation-v1";

assert.ok(verifyCogsReconciliationContractStatic());

const phaseScript = fs.readFileSync(
  path.join(process.cwd(), "scripts/phase-product-cogs-ui-input-reconciliation-v1.ts"),
  "utf8",
);
assert.match(phaseScript, /input-reconciliation/);
assert.match(phaseScript, /SAFE_TO_EXECUTE_COGS_WITH_EXISTING_INPUT/);

console.log(
  JSON.stringify({
    smoke: "pass",
    version: PRODUCT_COGS_UI_INPUT_RECONCILIATION_V1,
    SAFE_COGS_RECONCILIATION_CONTRACT: "ok",
  }),
);
