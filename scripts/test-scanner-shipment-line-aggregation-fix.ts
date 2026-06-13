/**
 * PHASE-SCANNER-SHIPMENT-LINE-AGGREGATION-FIX-387003587-X004LKS4VD — unit smoke
 *   npx tsx scripts/test-scanner-shipment-line-aggregation-fix.ts
 */
import assert from "node:assert/strict";

import {
  EXPECTED_PACKAGE_UI_COPY,
  classifyExpectedPackageBuildStatus,
  filterExpectedPackagesForClaimGeneration,
} from "../lib/expected-packages-conflict-status";
import {
  aggregateExpectedPackageRowsForInventoryDisplay,
  finalizeInventoryGateDisplayRows,
  groupInventoryStatusRowsForDisplay,
  inventoryDisplayGroupBadgeLabels,
  inventoryDisplayGroupKey,
  resolveInventoryDisputedQuantity,
  resolveInventoryExpectedClean,
} from "../lib/scanner/v-inventory-status";
import { expectedPackageRowToInventoryStatusRow } from "../lib/scanner/scanner-identity-lookup";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "387003587";
const FNSKU = "X004LKS4VD";
const SKU = "B01C7G00TA-VEN";
const PRODUCT_ID = "7e5e05f7-c98a-41a7-85e8-62720ffdc8de";

function main(): void {
  const rawEpRows = [
    {
      id: "ep-a",
      tracking_number: TRACKING,
      id_slip_contents: "SLIP-1",
      sku: SKU,
      fnsku: FNSKU,
      order_id: "ORDER-1",
      expected_scan_quantity: 52,
      actual_scanned_count: 0,
      build_status: "matched",
      resolved_product_id: PRODUCT_ID,
    },
    {
      id: "ep-b",
      tracking_number: TRACKING,
      id_slip_contents: "SLIP-1",
      sku: SKU,
      fnsku: FNSKU,
      order_id: "ORDER-1",
      expected_scan_quantity: 1,
      actual_scanned_count: 0,
      build_status: "shipment_overflow_conflict",
      resolved_product_id: PRODUCT_ID,
    },
  ] as Record<string, unknown>[];

  assert.equal(classifyExpectedPackageBuildStatus("matched"), "clean");
  assert.equal(classifyExpectedPackageBuildStatus("shipment_overflow_conflict"), "disputed");

  const oldPerRow = rawEpRows.map((r) => expectedPackageRowToInventoryStatusRow(r, ORG, STORE));
  assert.equal(oldPerRow.length, 2, "old path: one card per expected_packages row");

  const grouped = aggregateExpectedPackageRowsForInventoryDisplay(rawEpRows, ORG, STORE);
  assert.equal(grouped.length, 1, "aggregated display lines");
  assert.equal(resolveInventoryExpectedClean(grouped[0]!), 52, "clean expected qty");
  assert.equal(resolveInventoryDisputedQuantity(grouped[0]!), 1, "disputed qty");
  assert.equal(grouped[0]?.total_expected, 52, "total_expected is clean-only for gate progress");
  assert.equal(grouped[0]?.total_scanned, 0, "scanned qty sum");
  assert.equal(grouped[0]?.fnsku, FNSKU);
  assert.equal(grouped[0]?.resolved_product_id, PRODUCT_ID);
  assert.equal(grouped[0]?.needs_reconciliation, true);

  const badges = inventoryDisplayGroupBadgeLabels(grouped[0]?.display_group);
  assert.ok(badges.includes("matched"), "matched badge");
  assert.ok(badges.includes(EXPECTED_PACKAGE_UI_COPY.needsReconciliation), "needs reconciliation badge");
  assert.ok(badges.includes(EXPECTED_PACKAGE_UI_COPY.shipmentDetailQtyDisagree), "shipment/detail disagree badge");

  const claimFilter = filterExpectedPackagesForClaimGeneration(rawEpRows);
  assert.equal(claimFilter.claimReady.length, 1);
  assert.equal(claimFilter.reviewNeeded.length, 1);

  const oldKeyA = inventoryDisplayGroupKey(oldPerRow[0]!);
  const oldKeyB = inventoryDisplayGroupKey(oldPerRow[1]!);
  assert.equal(oldKeyA, oldKeyB, "same operational product scope shares one grouping key");

  const rpcLike = finalizeInventoryGateDisplayRows(oldPerRow);
  assert.equal(rpcLike.length, 1, "view-shaped rows merge to one product card");
  assert.equal(rpcLike[0]?.total_expected, 53, "without EP build_status enrichment, view rows still sum raw totals");

  const distinctProduct = groupInventoryStatusRowsForDisplay([
    {
      ...oldPerRow[0]!,
      resolved_product_id: "11111111-1111-1111-1111-111111111111",
      expected_package_id: "x",
    },
    {
      ...oldPerRow[1]!,
      resolved_product_id: "22222222-2222-2222-2222-222222222222",
      expected_package_id: "y",
    },
  ]);
  assert.equal(distinctProduct.length, 2, "different resolved_product_id must not merge");

  const oldDisplayTotal = 53;
  console.log(
    JSON.stringify(
      {
        prompt: "PHASE-EXPECTED-PACKAGES-CONFLICT-STATUS-GATING-V1",
        grouped_display_result_for_387003587_X004LKS4VD: {
          display_lines: grouped.length,
          old_display_total: oldDisplayTotal,
          expected_clean: resolveInventoryExpectedClean(grouped[0]!),
          disputed_quantity: resolveInventoryDisputedQuantity(grouped[0]!),
          total_expected_gate: grouped[0]?.total_expected,
          scanned: grouped[0]?.total_scanned,
          fnsku: grouped[0]?.fnsku,
          sku: grouped[0]?.sku,
          resolved_product_id: grouped[0]?.resolved_product_id,
          badges,
          claim_ready_rows: claimFilter.claimReady.length,
          review_needed_rows: claimFilter.reviewNeeded.length,
        },
        raw_rows_preserved: rawEpRows.length,
        PASS: true,
      },
      null,
      2,
    ),
  );
}

main();
