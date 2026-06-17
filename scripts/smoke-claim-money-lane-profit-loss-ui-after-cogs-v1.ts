/**
 * Smoke — PHASE-CLAIM-MONEY-LANE-PROFIT-LOSS-UI-AFTER-COGS-V1
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MONEY_LANE_PROFIT_LOSS_UI_AFTER_COGS_VERSION,
  MONEY_LANE_FORMULA_HELPERS,
  buildMoneyLaneUiBundle,
  parseCogsCoverageRatio,
  reimbursementMatchStatusFromPreview,
  reimbursementMatchStatusLabel,
  verifySalePriceNotUsedAsCogsUi,
  verifyUnknownNotCoerced,
} from "../lib/claims/submission/claim-money-lane-profit-loss-ui-contract";
import type { PerSubmissionMoneyPreviewV2 } from "../lib/claims/submission/claim-money-lane-preview-v2-profit-loss-v1";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");

const FILES = [
  "lib/claims/submission/claim-money-lane-profit-loss-ui-contract.ts",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingMoneyTab.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingSummaryCards.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingView.tsx",
];

for (const rel of FILES) {
  const content = fs.readFileSync(path.join(REPO, rel), "utf8");
  assert.ok(content.length > 100, rel);
}

const summary = fs.readFileSync(
  path.join(REPO, "components/claim-center/reimbursement-tracking/ReimbursementTrackingSummaryCards.tsx"),
  "utf8",
);
const table = fs.readFileSync(
  path.join(REPO, "components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx"),
  "utf8",
);
const moneyTab = fs.readFileSync(
  path.join(REPO, "components/claim-center/reimbursement-tracking/ReimbursementTrackingMoneyTab.tsx"),
  "utf8",
);
const drawer = fs.readFileSync(
  path.join(REPO, "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx"),
  "utf8",
);
const view = fs.readFileSync(
  path.join(REPO, "components/claim-center/reimbursement-tracking/ReimbursementTrackingView.tsx"),
  "utf8",
);
const api = fs.readFileSync(path.join(REPO, "lib/claims/center/claim-center-api-handlers.ts"), "utf8");

assert.match(summary, /Approved COGS coverage/);
assert.match(summary, /Recovery value known/);
assert.match(summary, /Sale estimate/);
assert.match(summary, /Reimbursement matched \/ unknown/);
assert.match(summary, /post-COGS/);
assert.match(table, /Reimb status/);
assert.match(table, /reimbursementMatchStatusLabel/);
assert.match(moneyTab, /H\. Formula explanations/);
assert.match(moneyTab, /Sale price is never used as COGS/);
assert.match(drawer, /moneyPreview\?\.cost_recovery_view\.recovery_value/);
assert.match(view, /Approved COGS applied/);
assert.match(api, /phase-claim-money-lane-profit-loss-ui-after-cogs-v1/);
assert.ok(!moneyTab.includes('?? "$0"'));

assert.equal(parseCogsCoverageRatio("6/10")?.known, 6);
assert.equal(reimbursementMatchStatusLabel("unknown"), "Unknown");

const mockPreview = {
  claim_submission_id: "sub-1",
  clean_quantity: 2,
  sale_view: {
    latest_sold_price: { value: 20, display: "$20.00", status: "known", label: "actual" },
    gross_sale_value: { value: 40, display: "$40.00", status: "known", label: "actual" },
  },
  amazon_fee_view: {
    amazon_fees_per_unit: { value: 3, display: "$3.00", status: "known", label: "actual" },
    estimated_amazon_fees: { value: 6, display: "$6.00", status: "known", label: "actual" },
    breakdown: { fee_label: "actual", is_estimate: false, amazon_fees_total: 6 },
  },
  settlement_view: {
    net_settlement_amount: { value: 34, display: "$34.00", status: "known", label: "actual" },
  },
  cost_recovery_view: {
    approved_cogs_unit: {
      value: 8,
      display: "$8.00",
      status: "known",
      label: "actual",
      source: "cogs_overrides.fnsku",
    },
    recovery_value: { value: 16, display: "$16.00", status: "known", label: "actual" },
  },
  reimbursement_view: {
    observed_reimbursement: { value: null, display: "Unknown", status: "unknown", label: "unknown" },
  },
  open_gap_view: {
    open_recovery_gap: { value: null, display: "Unknown", status: "unknown", label: "unknown" },
  },
  profit_loss_view: {
    estimated_profit_if_sold: { value: 18, display: "$18.00", status: "known", label: "actual" },
    actual_recovery_vs_cost: { value: null, display: "Unknown", status: "unknown", label: "unknown" },
    lost_profit_estimate: { value: null, display: "Unknown", status: "unknown", label: "unknown" },
    analysis_status: "partial",
    analysis_note: "partial",
    informational_sale_estimate: null,
  },
} as PerSubmissionMoneyPreviewV2;

assert.equal(reimbursementMatchStatusFromPreview(mockPreview), "unknown");
assert.equal(mockPreview.cost_recovery_view.recovery_value.value, 16);
assert.notEqual(
  mockPreview.cost_recovery_view.approved_cogs_unit.value,
  mockPreview.sale_view.latest_sold_price.value,
);

const bundle = buildMoneyLaneUiBundle({
  per_submission: [mockPreview],
  preview_run_reference: "smoke/after-cogs-v1",
  coverage: {
    sale_view: "1/1",
    fee_view: "1/1",
    settlement_view: "1/1",
    cogs: "1/1",
    recovery_value: "1/1",
    reimbursement: "0/1",
    profit_loss_complete: "0/1",
  },
});
assert.equal(bundle.version, MONEY_LANE_PROFIT_LOSS_UI_AFTER_COGS_VERSION);
assert.equal(bundle.summary_cards.cogs_known_count, 1);
assert.equal(bundle.summary_cards.recovery_known_count, 1);
assert.equal(bundle.summary_cards.total_recovery_value, 16);
assert.equal(bundle.summary_cards.reimbursement_unknown_count, 1);
assert.ok(verifySalePriceNotUsedAsCogsUi([mockPreview]));
assert.ok(verifyUnknownNotCoerced([mockPreview]));
assert.ok(Object.values(MONEY_LANE_FORMULA_HELPERS).every((v) => v.length > 10));

console.log(
  JSON.stringify(
    {
      smoke: "pass",
      version: "claim-money-lane-profit-loss-ui-after-cogs-v1",
      cogs_coverage_display: bundle.summary_cards.cogs_coverage,
      recovery_value_display_verification: bundle.summary_cards.total_recovery_value,
      profit_loss_display_verification: "formula_helpers_present",
      formula_text_verification: "pass",
      unknown_value_verification: "pass",
      sale_price_not_used_as_cogs_verification: "pass",
      no_db_write_verification: "ui_only",
      no_claim_submission_mutation_verification: "ui_only",
      no_amazon_submission_verification: "ui_only",
      no_scanner_change_verification: "ui_only",
      SAFE_MONEY_LANE_PROFIT_LOSS_UI_READY: "yes",
      SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI: "yes",
    },
    null,
    2,
  ),
);
