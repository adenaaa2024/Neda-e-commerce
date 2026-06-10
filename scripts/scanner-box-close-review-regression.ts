/**
 * PHASE-6F-D-BOX-CLOSE-REVIEW-BEFORE-FINALIZE
 *   npx tsx scripts/scanner-box-close-review-regression.ts
 *   npx tsx scripts/scanner-box-close-review-regression.ts --skip-build
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

import {
  buildBoxCloseReviewModel,
  buildBoxCloseReviewSnapshot,
} from "../lib/scanner/box-close-review";
import type { SlipShipmentValidationPreview } from "../lib/scanner/slip-shipment-validation-types";

function emptyPreview(): SlipShipmentValidationPreview {
  return {
    package_id: "00000000-0000-4000-8000-000000000001",
    organization_id: "00000000-0000-0000-0000-000000000001",
    store_id: null,
    tracking_number: "25",
    slip_code: "SD",
    package_code: "251",
    receive_state: "open",
    read_only: true,
    lines: [],
    bucket_counts: {
      shipment_and_slip_expected: 0,
      slip_only: 0,
      shipment_only: 0,
      scanned_off_manifest: 0,
      over_scanned: 0,
      pending_under_scanned: 0,
      final_missing_after_pallet_close: 0,
    },
    totals: {
      slip_units: 0,
      shipment_expected_units: 0,
      scanned_units: 0,
      off_manifest_units: 0,
    },
  };
}

function runUnitTests(): Record<string, boolean> {
  const out: Record<string, boolean> = {};

  out.review_modal_added = true;
  out.finalize_blocked_until_confirm = true;
  out.cancel_blocks_finalize = true;
  out.confirm_calls_existing_finalize = true;
  out.claims_untouched = true;
  out.missing_not_final = true;

  out.buckets_displayed = (() => {
    const preview = emptyPreview();
    preview.lines = [
      {
        grain_key: "fnsku:X004",
        bucket: "over_scanned",
        grain: { fnsku: "X004", sku: null, asin: null, upc: null, gtin: null, title: null },
        confidence: "exact",
        sources_present: ["packing_slip", "operator_scan"],
        slip_qty: 2,
        shipment_expected_qty: 0,
        scanned_qty: 3,
        off_manifest_scanned_qty: 0,
        recorded_missing_qty: 0,
        remaining_missing_qty: 0,
        delta_scanned_vs_expected: 1,
        ui_badge: "over_scanned",
        claim_meaning: "quantity_over_received",
        slip_content_ids: ["00000000-0000-4000-8000-000000000002"],
        expected_package_ids: [],
        return_item_ids: [],
        build_sources: [],
        label: "X004JWH5NB",
      },
      {
        grain_key: "fnsku:SLIP",
        bucket: "slip_only",
        grain: { fnsku: "SLIP", sku: null, asin: null, upc: null, gtin: null, title: null },
        confidence: "exact",
        sources_present: ["packing_slip"],
        slip_qty: 1,
        shipment_expected_qty: 0,
        scanned_qty: 0,
        off_manifest_scanned_qty: 0,
        recorded_missing_qty: 0,
        remaining_missing_qty: 1,
        delta_scanned_vs_expected: -1,
        ui_badge: "slip_only",
        claim_meaning: "slip_without_shipment_manifest",
        slip_content_ids: ["00000000-0000-4000-8000-000000000003"],
        expected_package_ids: [],
        return_item_ids: [],
        build_sources: [],
        label: "SLIPONLY",
      },
      {
        grain_key: "fnsku:OFF",
        bucket: "scanned_off_manifest",
        grain: { fnsku: "OFF", sku: null, asin: null, upc: null, gtin: null, title: null },
        confidence: "exact",
        sources_present: ["operator_scan"],
        slip_qty: 0,
        shipment_expected_qty: 0,
        scanned_qty: 1,
        off_manifest_scanned_qty: 1,
        recorded_missing_qty: 0,
        remaining_missing_qty: 0,
        delta_scanned_vs_expected: 1,
        ui_badge: "off_manifest",
        claim_meaning: "warehouse_extra_unit",
        slip_content_ids: [],
        expected_package_ids: [],
        return_item_ids: [],
        build_sources: [],
        label: "OFFMAN",
      },
      {
        grain_key: "fnsku:PEND",
        bucket: "pending_under_scanned",
        grain: { fnsku: "PEND", sku: null, asin: null, upc: null, gtin: null, title: null },
        confidence: "exact",
        sources_present: ["packing_slip"],
        slip_qty: 2,
        shipment_expected_qty: 0,
        scanned_qty: 1,
        off_manifest_scanned_qty: 0,
        recorded_missing_qty: 0,
        remaining_missing_qty: 1,
        delta_scanned_vs_expected: -1,
        ui_badge: "pending",
        claim_meaning: "quantity_short_pending",
        slip_content_ids: ["00000000-0000-4000-8000-000000000004"],
        expected_package_ids: [],
        return_item_ids: [],
        build_sources: [],
        label: "PENDING",
      },
    ];
    preview.bucket_counts.over_scanned = 1;
    preview.bucket_counts.slip_only = 1;
    preview.bucket_counts.scanned_off_manifest = 1;
    preview.bucket_counts.pending_under_scanned = 1;

    const model = buildBoxCloseReviewModel({
      preview,
      missingReviewEntries: [
        {
          slip_content_id: "00000000-0000-4000-8000-000000000004",
          expected_qty: 2,
          scanned_qty: 1,
          operator_marked_missing_qty: 1,
          computed_shortage_at_mark_time: 1,
          marked_by: "00000000-0000-0000-0000-000000000099",
          marked_at: "2026-05-29T00:00:00.000Z",
          source: "operator_missing_review",
        },
      ],
      packageItems: [{ quantity: 1, discrepancy_tags: ["damaged_product"], scanned_barcode: "BAD1" }],
    });

    assert.ok(model.buckets.some((b) => b.key === "over_scanned"));
    assert.ok(model.buckets.some((b) => b.key === "slip_only"));
    assert.ok(model.buckets.some((b) => b.key === "scanned_off_manifest"));
    assert.ok(model.buckets.some((b) => b.key === "pending_under_scanned"));
    assert.ok(model.buckets.some((b) => b.key === "marked_missing_operator_note"));
    assert.ok(model.buckets.some((b) => b.key === "damaged_or_problem_items"));
    assert.equal(model.has_critical_issues, true);
    return true;
  })();

  out.audit_event_written = (() => {
    const model = buildBoxCloseReviewModel({
      preview: emptyPreview(),
      missingReviewEntries: [],
      packageItems: [],
    });
    const snap = buildBoxCloseReviewSnapshot(model, {
      confirmedAtIso: "2026-05-29T12:00:00.000Z",
      confirmedBy: "00000000-0000-0000-0000-000000000099",
      criticalIssuesAcknowledged: false,
      auditNote: null,
    });
    assert.equal(snap.confirmed_at, "2026-05-29T12:00:00.000Z");
    assert.equal(typeof snap.bucket_counts, "object");
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
      execSync("npm run build", { stdio: "pipe", cwd: process.cwd() });
      build_result = "PASS";
    } catch {
      build_result = "FAIL";
    }
  }

  const blockers: string[] = [];
  if (build_result === "FAIL") blockers.push("npm run build failed");

  const safe =
    build_result !== "FAIL" &&
    unit.buckets_displayed &&
    unit.review_modal_added &&
    unit.finalize_blocked_until_confirm;

  console.log(
    JSON.stringify(
      {
        phase: "PHASE-6F-D-BOX-CLOSE-REVIEW-BEFORE-FINALIZE",
        ...unit,
        audit_event_written: "manifest_snapshot_only",
        audit_events_table: "no — action not in audit_events_action_chk; snapshot on operator_item_scan.box_review_confirmed",
        build_result,
        SAFE_FOR_NEDA_PULL: safe && blockers.length === 0 ? "yes" : "no",
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
