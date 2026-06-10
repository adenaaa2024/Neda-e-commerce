/**
 * FIX-SCANNER-OVER-STATE-DISPLAY-AFTER-CONFIRM
 *   npx tsx scripts/scanner-over-status-display-regression.ts
 *   npx tsx scripts/scanner-over-status-display-regression.ts --skip-build
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { buildBoxCloseReviewModel } from "../lib/scanner/box-close-review";
import { nedaQuantityRowPresentation } from "../lib/scanner/neda-quantity-color-matrix";
import {
  computeSlipLineExpectedVsReceived,
  formatSlipLineQtySummary,
  slipLineStatusBadgeState,
} from "../lib/scanner/slip-contents-missing-expected";
import type { SlipShipmentValidationPreview } from "../lib/scanner/slip-shipment-validation-types";

function line(expected: number, received: number, recordedMissing = 0) {
  return computeSlipLineExpectedVsReceived({
    expectedQty: expected,
    receivedQty: received,
    manifestRecordedMissingQty: recordedMissing,
  });
}

function runUnitTests(): Record<string, boolean> {
  const out: Record<string, boolean> = {};

  out.over_status_precedence_fixed = (() => {
    // received > expected → OVER (never RECEIVED)
    assert.deepEqual(slipLineStatusBadgeState(line(1, 3), false), { label: "Over", tone: "over" });
    assert.deepEqual(slipLineStatusBadgeState(line(2, 3), false), { label: "Over", tone: "over" });
    // received == expected → RECEIVED
    assert.deepEqual(slipLineStatusBadgeState(line(2, 2), false), {
      label: "Received",
      tone: "received",
    });
    // 0 < received < expected → In progress
    assert.deepEqual(slipLineStatusBadgeState(line(2, 1), false), {
      label: "In progress",
      tone: "awaiting",
    });
    // received == 0 → Pending
    assert.deepEqual(slipLineStatusBadgeState(line(2, 0), false), {
      label: "Pending",
      tone: "awaiting",
    });
    // marked missing wins over partial when entry present
    assert.deepEqual(slipLineStatusBadgeState(line(3, 1, 2), true), {
      label: "Marked missing",
      tone: "marked",
    });
    // ...but OVER still wins even with stale missing review
    assert.equal(slipLineStatusBadgeState(line(1, 3, 1), true).tone, "over");
    return true;
  })();

  out.received_no_longer_wins_when_over = (() => {
    for (const [exp, rec] of [
      [1, 2],
      [1, 3],
      [2, 3],
      [2, 4],
    ] as const) {
      const state = slipLineStatusBadgeState(line(exp, rec), false);
      assert.notEqual(state.label, "Received", `expected ${exp} received ${rec} must not be Received`);
      assert.equal(state.tone, "over");
    }
    return true;
  })();

  out.counts_show_over_quantity = (() => {
    assert.equal(formatSlipLineQtySummary(line(1, 3)), "Expected 1 · Received 3 · Over 2");
    assert.equal(formatSlipLineQtySummary(line(2, 2)), "Expected 2 · Received 2");
    assert.equal(formatSlipLineQtySummary(line(2, 0)), "Expected 2 · Received 0 · Pending 2");
    return true;
  })();

  out.row_surface_over_precedence = (() => {
    // Card surface matrix: over wins before received in both modes
    assert.equal(nedaQuantityRowPresentation(1, 3, false).label, "OVER");
    assert.equal(nedaQuantityRowPresentation(1, 3, true).label, "OVER");
    assert.equal(nedaQuantityRowPresentation(2, 2, false).label, "RECEIVED");
    assert.equal(nedaQuantityRowPresentation(2, 1, false).label, "IN PROGRESS");
    assert.equal(nedaQuantityRowPresentation(2, 0, false).label, "Awaiting");
    // shipment-only / off-slip grain: expected 0 scanned > 0 stays OVER (red)
    assert.equal(nedaQuantityRowPresentation(0, 1, false).label, "OVER");
    return true;
  })();

  out.delete_recalculates_status = (() => {
    // received 3 → delete → 2 == expected → RECEIVED; delete → 1 < expected → In progress; → 0 → Pending
    assert.equal(slipLineStatusBadgeState(line(2, 3), false).tone, "over");
    assert.equal(slipLineStatusBadgeState(line(2, 2), false).label, "Received");
    assert.equal(slipLineStatusBadgeState(line(2, 1), false).label, "In progress");
    assert.equal(slipLineStatusBadgeState(line(2, 0), false).label, "Pending");
    return true;
  })();

  out.box_review_over_bucket_ok = (() => {
    const preview: SlipShipmentValidationPreview = {
      package_id: "00000000-0000-4000-8000-000000000001",
      organization_id: "00000000-0000-0000-0000-000000000001",
      store_id: null,
      tracking_number: "25",
      slip_code: null,
      package_code: "251",
      receive_state: "open",
      read_only: true,
      lines: [
        {
          grain_key: "fnsku:X004JWH5NB",
          bucket: "over_scanned",
          grain: { fnsku: "X004JWH5NB", sku: null, asin: null, upc: null, gtin: null, title: null },
          confidence: "exact",
          sources_present: ["packing_slip", "operator_scan"],
          slip_qty: 1,
          shipment_expected_qty: 0,
          scanned_qty: 3,
          off_manifest_scanned_qty: 0,
          recorded_missing_qty: 0,
          remaining_missing_qty: 0,
          delta_scanned_vs_expected: 2,
          ui_badge: "over_scanned",
          claim_meaning: "quantity_over_received",
          slip_content_ids: ["00000000-0000-4000-8000-000000000002"],
          expected_package_ids: [],
          return_item_ids: [],
          build_sources: [],
          label: "X004JWH5NB",
        },
      ],
      bucket_counts: {
        shipment_and_slip_expected: 0,
        slip_only: 0,
        shipment_only: 0,
        scanned_off_manifest: 0,
        over_scanned: 1,
        pending_under_scanned: 0,
        final_missing_after_pallet_close: 0,
      },
      totals: { slip_units: 1, shipment_expected_units: 0, scanned_units: 3, off_manifest_units: 0 },
    };
    const model = buildBoxCloseReviewModel({ preview, missingReviewEntries: [], packageItems: [] });
    const overBucket = model.buckets.find((b) => b.key === "over_scanned");
    assert.ok(overBucket && overBucket.count === 1);
    assert.equal(model.bucket_counts.over_scanned, 1);
    return true;
  })();

  out.over_pill_visible = (() => {
    const scanPage = fs.readFileSync(
      path.join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"),
      "utf8",
    );
    assert.ok(scanPage.includes("slipLineStatusBadgeState"), "page must use shared badge state");
    assert.ok(
      scanPage.includes('data-neda-qty="OVER"'),
      "over pill must carry data-neda-qty OVER for existing CSS",
    );
    assert.ok(
      !scanPage.includes("line.received >= line.expected"),
      "old received-wins-when-over comparison must be gone",
    );
    return true;
  })();

  out.over_color_preserved = (() => {
    const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
    // Existing OVER tokens untouched — pill reuses them, no new color tokens
    assert.ok(css.includes('.operator-item-scan-slip-status[data-neda-qty="OVER"]'));
    assert.ok(css.includes('[data-neda-qty="RECEIVED"]'));
    assert.ok(css.includes("operator-item-scan-slip-passive-badge--pending"));
    return true;
  })();

  return out;
}

async function main(): Promise<void> {
  const skipBuild = process.argv.includes("--skip-build");
  const unit = runUnitTests();

  let build_result = "SKIP";
  if (!skipBuild) {
    try {
      execSync("npm run build", { stdio: "pipe", cwd: process.cwd(), timeout: 240_000 });
      build_result = "PASS";
    } catch {
      build_result = "FAIL";
    }
  }

  const blockers: string[] = [];
  if (build_result === "FAIL") blockers.push("npm run build failed");

  const safe = Object.values(unit).every(Boolean) && build_result !== "FAIL";

  console.log(
    JSON.stringify(
      {
        phase: "FIX-SCANNER-OVER-STATE-DISPLAY-AFTER-CONFIRM",
        ...unit,
        build_result,
        SAFE_TO_PUSH_AND_NEDA_PULL: safe && blockers.length === 0 ? "yes" : "no",
        blockers,
      },
      null,
      2,
    ),
  );

  if (!safe || blockers.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
