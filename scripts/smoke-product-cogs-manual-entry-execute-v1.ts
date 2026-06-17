/**
 * smoke-product-cogs-manual-entry-execute-v1 — static safety checks
 *   npx tsx scripts/smoke-product-cogs-manual-entry-execute-v1.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const executeLib = readFileSync(
  "lib/claims/submission/product-cogs-manual-entry-execute-v1.ts",
  "utf8",
);
const overrideLib = readFileSync("lib/claims/submission/cogs-override-value-v1.ts", "utf8");
const discovery = readFileSync(
  "lib/claims/submission/claim-money-lane-source-discovery-v1.ts",
  "utf8",
);
const audit = readFileSync("lib/claims/submission/product-cogs-audit-v1.ts", "utf8");
const uiLib = readFileSync("lib/claims/submission/product-cogs-manual-entry-ui-v1.ts", "utf8");
const feeModel = readFileSync("lib/fees/fee-adjusted-estimate-readmodel.ts", "utf8");
const phaseScript = readFileSync(
  "scripts/phase-product-cogs-manual-entry-execute-v1.ts",
  "utf8",
);

assert.match(executeLib, /workspace_settings/);
assert.match(executeLib, /cogs_overrides/);
assert.match(executeLib, /platform_automation_audit_log/);
assert.match(executeLib, /attemptGuardedCogsWriteV1/);
assert.match(executeLib, /readCogsExecuteDualApprovalStatus/);
assert.match(executeLib, /ALLOW_PARTIAL_COGS_WRITE/);
assert.match(executeLib, /APPROVED_PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1/);
assert.match(executeLib, /buildCogsOverridesRollbackSql/);
assert.doesNotMatch(executeLib, /\.from\("claim_submissions"\)\s*\.update/);
assert.doesNotMatch(executeLib, /\.from\("claim_cases"\)\s*\.update/);
assert.doesNotMatch(executeLib, /\.from\("claim_lines"\)\s*\.update/);
assert.doesNotMatch(executeLib, /\.from\("claim_candidates"\)\s*\.update/);

assert.match(overrideLib, /extractCogsOverrideUnitCost/);
assert.match(discovery, /extractCogsOverrideUnitCost/);
assert.match(audit, /extractCogsOverrideUnitCost/);
assert.match(uiLib, /extractCogsOverrideUnitCost/);
assert.match(feeModel, /extractCogsOverrideUnitCost/);

assert.match(phaseScript, /phase-product-cogs-manual-entry-execute-v1/);
assert.match(phaseScript, /--execute/);
assert.match(phaseScript, /rollback\.sql/);

console.log("smoke-product-cogs-manual-entry-execute-v1: pass");
