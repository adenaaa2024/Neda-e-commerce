/**
 * Smoke — PHASE-CLAIM-MONEY-LANE-PROFIT-LOSS-UI-V1
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");

const FILES = [
  "lib/claims/submission/claim-money-lane-profit-loss-ui-contract.ts",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingMoneyTab.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingMoneyBadges.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingSummaryCards.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx",
];

for (const rel of FILES) {
  const content = fs.readFileSync(path.join(REPO, rel), "utf8");
  assert.ok(content.length > 100, rel);
}

const drawer = fs.readFileSync(
  path.join(REPO, "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx"),
  "utf8",
);
const moneyTab = fs.readFileSync(
  path.join(REPO, "components/claim-center/reimbursement-tracking/ReimbursementTrackingMoneyTab.tsx"),
  "utf8",
);
const table = fs.readFileSync(
  path.join(REPO, "components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx"),
  "utf8",
);
const summary = fs.readFileSync(
  path.join(REPO, "components/claim-center/reimbursement-tracking/ReimbursementTrackingSummaryCards.tsx"),
  "utf8",
);

assert.match(drawer, /Overview.*Money.*Evidence.*Raw details/s);
assert.match(moneyTab, /MONEY_LANE_FORMULA_HELPERS/);
assert.match(moneyTab, /Sale price is never used as COGS/);
assert.match(moneyTab, /Unknown/);
assert.match(table, /Sold price/);
assert.match(table, /Lost profit/);
assert.match(summary, /Money lane summary/);
assert.match(summary, /Sale estimate/);
assert.ok(!moneyTab.includes('?? "$0"'));

console.log(
  JSON.stringify({
    smoke: "pass",
    version: "claim-money-lane-profit-loss-ui-v1",
    SAFE_MONEY_LANE_PROFIT_LOSS_UI_READY: "contract_ok",
  }),
);
