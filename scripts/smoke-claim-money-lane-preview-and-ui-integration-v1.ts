/**
 * Smoke — PHASE-CLAIM-MONEY-LANE-PREVIEW-AND-UI-INTEGRATION-V1
 */
import assert from "node:assert/strict";

import {
  CLAIM_MONEY_LANE_PREVIEW_UI_INTEGRATION_V1,
  MONEY_LANE_INTEGRATION_FORMULA_CONTRACT,
  REIMBURSEMENT_TRACKING_MONEY_TABLE_COLUMNS,
  verifyApiHandlerWiresMoneyLane,
  verifyIntegrationFormulaContract,
  verifyIntegrationUiSourceFilesExist,
  verifyReimbursementTrackingUiMoneyIntegration,
} from "../lib/claims/submission/claim-money-lane-preview-ui-integration-v1";
import { reimbursementMatchStatusLabel } from "../lib/claims/submission/claim-money-lane-profit-loss-ui-contract";

assert.ok(verifyIntegrationUiSourceFilesExist());
assert.ok(verifyIntegrationFormulaContract());
assert.ok(verifyApiHandlerWiresMoneyLane());

const ui = verifyReimbursementTrackingUiMoneyIntegration();
assert.equal(ui.table_columns, true);
assert.equal(ui.detail_drawer_money_panel, true);
assert.equal(ui.formula_tooltips, true);
assert.equal(ui.cogs_missing_blocker_badge, true);
assert.equal(ui.reimbursement_not_matched_label, true);
assert.equal(ui.unknown_not_zero, true);

assert.equal(reimbursementMatchStatusLabel("unknown"), "Not filed / no safe match");
assert.equal(REIMBURSEMENT_TRACKING_MONEY_TABLE_COLUMNS.length, 7);
assert.ok(MONEY_LANE_INTEGRATION_FORMULA_CONTRACT.recovery_value.includes("clean_quantity"));

console.log(
  JSON.stringify({
    smoke: "pass",
    version: CLAIM_MONEY_LANE_PREVIEW_UI_INTEGRATION_V1,
    ui_verification: ui,
    SAFE_MONEY_LANE_PREVIEW_UI_INTEGRATION: "contract_ok",
  }),
);
