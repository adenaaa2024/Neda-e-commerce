/**
 * Smoke — PHASE-CLAIM-MONEY-LANE-PREVIEW-V1
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");
const LIB = path.join(REPO, "lib/claims/submission/claim-money-lane-preview-v1.ts");

const lib = fs.readFileSync(LIB, "utf8");

assert.match(lib, /CLAIM_MONEY_LANE_PREVIEW_V1_VERSION/);
assert.match(lib, /MONEY_LANE_FORMULA_CONTRACT/);
assert.match(lib, /recovery_value/);
assert.match(lib, /approved_cogs_unit/);
assert.match(lib, /never_sale_price/);
assert.match(lib, /OBSERVED_REIMBURSEMENT_NO_SAFE_MATCH/);
assert.match(lib, /displayValue/);
assert.match(lib, /Unknown/);
assert.ok(!lib.includes('?? "$0"'));

console.log(
  JSON.stringify({
    smoke: "pass",
    version: "claim-money-lane-preview-v1",
    SAFE_MONEY_LANE_PREVIEW_READY: "contract_ok",
  }),
);
