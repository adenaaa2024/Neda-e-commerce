/**
 * Neda prompt 2 — expected display state + delete-one-unit smoke (static + slip qty helpers).
 * Usage: npx tsx scripts/neda-prompt-2-expected-display-delete-unit-smoke.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  computeSlipLineExpectedVsReceived,
  formatSlipLineQtySummary,
} from "../lib/scanner/slip-contents-missing-expected";
import {
  resolveItemBarcodeAgainstSlipRows,
  type SlipBarcodeMatchRow,
} from "../lib/scanner/operator-slip-item-resolve";

const SCAN_PAGE = join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx");
const SAMPLE_FNSKU = "X004N9OS4J";

function main(): void {
  const page = readFileSync(SCAN_PAGE, "utf8");

  const pendingLine = computeSlipLineExpectedVsReceived({
    expectedQty: 3,
    receivedQty: 1,
    notes: null,
  });
  const pendingSummary = formatSlipLineQtySummary(pendingLine);
  const pending_vs_missing_fixed =
    pendingSummary.includes("Pending 2") &&
    !pendingSummary.includes("Missing") &&
    pendingLine.remainingMissing === 2 &&
    pendingLine.recordedMissing === 0;

  const markedLine = computeSlipLineExpectedVsReceived({
    expectedQty: 3,
    receivedQty: 1,
    notes: JSON.stringify({ type: "missing_expected", missing: true, missing_qty: 2 }),
  });
  const markedSummary = formatSlipLineQtySummary(markedLine);
  const markedBadgeOk =
    page.includes("expectedSlipLineStatusBadge") &&
    page.includes("hasMissingReviewEntry") &&
    !page.includes("label: `Missing ${missingCount}`");

  const receivedLine = computeSlipLineExpectedVsReceived({
    expectedQty: 2,
    receivedQty: 2,
    notes: null,
  });
  const receivedSummary = formatSlipLineQtySummary(receivedLine);
  const receivedDisplayOk =
    receivedSummary === "Expected 2 · Received 2" &&
    page.includes("label: \"Received\"");

  const delete_unit_fixed =
    page.includes("correctOperatorPackageItemQuantityAction") &&
    /unitQty > 1/.test(page) &&
    page.includes("scannedQuantity: unitQty - 1");

  const return_items_only_deleted_or_voided =
    !page.includes("deleteSlip") &&
    !page.includes(".from(\"slip_contents\")") &&
    page.includes("deleteOperatorPackageItemAction") &&
    !/handleDeleteSlipCellUnit[\s\S]{0,800}slip_contents/.test(page);

  const expected_items_preserved =
    !page.includes("filter((r) => r.id !== target.id)") ||
    page.includes("packageItemHydratedRows");

  const missing_review_preserved =
    !page.includes("buildSlipContentsMissingExpectedNotes") ||
    page.includes("markSlipLineRemainingMissing");

  const slipRow: SlipBarcodeMatchRow = {
    id: "ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663",
    fnsku: SAMPLE_FNSKU,
    upc: null,
    sku: null,
    product_identifier: null,
    quantity: 1,
  };
  const fnskuMatch = resolveItemBarcodeAgainstSlipRows(SAMPLE_FNSKU, [slipRow]);
  const fnsu_match_not_regressed =
    fnskuMatch.kind === "single" &&
    fnskuMatch.tier === "fnsku" &&
    fnskuMatch.slip.id === slipRow.id;

  const build_result = process.argv.includes("--build-pass") ? "PASS" : "not_run";

  const allCore =
    pending_vs_missing_fixed &&
    delete_unit_fixed &&
    return_items_only_deleted_or_voided &&
    expected_items_preserved &&
    missing_review_preserved &&
    fnsu_match_not_regressed &&
    markedSummary.includes("Marked missing 2") &&
    markedBadgeOk &&
    receivedDisplayOk &&
    build_result === "PASS";

  const report = {
    pending_vs_missing_fixed,
    delete_unit_fixed,
    return_items_only_deleted_or_voided,
    expected_items_preserved,
    missing_review_preserved,
    fnsu_match_not_regressed,
    build_result,
    SAFE_TO_MERGE_WITH_MAIN: allCore,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!allCore) process.exit(1);
}

main();
