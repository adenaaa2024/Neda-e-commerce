/**
 * Smoke — PHASE-CLAIM-MONEY-LANE-PREVIEW-V2-PROFIT-LOSS-ANALYSIS
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");
const LIB = path.join(REPO, "lib/claims/submission/claim-money-lane-preview-v2-profit-loss-v1.ts");

const lib = fs.readFileSync(LIB, "utf8");

assert.match(lib, /CLAIM_MONEY_LANE_PREVIEW_V2_VERSION/);
assert.match(lib, /MONEY_LANE_FORMULA_CONTRACT_V2/);
assert.match(lib, /profit_loss_view/);
assert.match(lib, /gross_sale_value/);
assert.match(lib, /lost_profit_estimate/);
assert.match(lib, /never_use_sale_price_as_cogs/);
assert.match(lib, /informational_sale_estimate/);
assert.match(lib, /fee_label/);
assert.match(lib, /never_mix_actual_and_estimate/);
assert.match(lib, /Unknown/);
assert.ok(!lib.includes('?? "$0"'));

console.log(
  JSON.stringify({
    smoke: "pass",
    version: "claim-money-lane-preview-v2-profit-loss-v1",
    SAFE_MONEY_LANE_PROFIT_LOSS_PREVIEW_READY: "contract_ok",
  }),
);
