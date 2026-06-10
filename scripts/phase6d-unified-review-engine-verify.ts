/**
 * PHASE-6D-UNIFIED-REVIEW-ENGINE verify
 *   npx tsx scripts/phase6d-unified-review-engine-verify.ts
 *   npx tsx scripts/phase6d-unified-review-engine-verify.ts --skip-build
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildBoxScopeReview,
  buildPalletScopeReview,
  buildShipmentScopeReview,
  classifyUnifiedReviewBucket,
  computeReviewGrainQuantities,
  emptyUnifiedBucketCounts,
  unifiedBucketToBoxCloseReviewKey,
  unifiedBucketToPalletShipmentBucket,
  unifiedBucketToSlipShipmentBucket,
} from "../lib/scanner/review-engine";

function verifySources(): Record<string, string> {
  const box = readFileSync(
    join(process.cwd(), "lib/scanner/slip-shipment-validation.ts"),
    "utf8",
  );
  const pallet = readFileSync(
    join(process.cwd(), "lib/scanner/pallet-shipment-review-preview.ts"),
    "utf8",
  );
  const boxReview = readFileSync(join(process.cwd(), "lib/scanner/box-close-review.ts"), "utf8");

  return {
    aggregation_source: "lib/scanner/review-engine/review-engine-aggregate.ts",
    box_review_source: box.includes("buildBoxScopeReview")
      ? "lib/scanner/slip-shipment-validation.ts → buildBoxScopeReview"
      : "missing",
    pallet_review_source: pallet.includes("buildPalletScopeReview")
      ? "lib/scanner/pallet-shipment-review-preview.ts → buildPalletScopeReview"
      : "missing",
    shipment_review_source: pallet.includes("buildShipmentScopeReview")
      ? "lib/scanner/pallet-shipment-review-preview.ts → buildShipmentScopeReview"
      : "missing",
    box_close_review_uses_engine_preview: boxReview.includes("unified review engine") ? "yes" : "no",
  };
}

function runUnitTests(): void {
  const q = computeReviewGrainQuantities({
    slip_qty: 2,
    shipment_expected_qty: 2,
    received_qty: 3,
    off_manifest_qty: 0,
    marked_missing_qty: 0,
    remaining_missing_qty: 0,
  });
  assert.equal(q.expected_qty, 2);
  assert.equal(q.received_qty, 3);
  assert.equal(q.over_qty, 1);

  const overBucket = classifyUnifiedReviewBucket({
    quantities: q,
    has_slip: true,
    has_shipment: true,
    receive_finalized: false,
  });
  assert.equal(overBucket, "over");

  assert.equal(
    unifiedBucketToSlipShipmentBucket("over", {
      has_slip: true,
      has_shipment: true,
      receive_finalized: false,
    }),
    "over_scanned",
  );
  assert.equal(
    unifiedBucketToPalletShipmentBucket("over", {
      problem_qty: 0,
      has_slip: true,
      has_shipment: true,
    }),
    "expected_over_received",
  );
  assert.equal(unifiedBucketToBoxCloseReviewKey("over"), "over_scanned");

  const review = buildBoxScopeReview({
    organization_id: "00000000-0000-0000-0000-000000000001",
    store_id: "00000000-0000-0000-0000-000000000002",
    package_ids: ["00000000-0000-0000-0000-000000000003"],
    pallet_id: null,
    tracking_numbers: ["TN1"],
    grains: [
      {
        grain_key: "g1",
        grain: {
          resolved_product_id: null,
          fnsku: "X001",
          asin: null,
          sku: null,
          upc: null,
          gtin: null,
          title: null,
        },
        label: "X001",
        slip_qty: 1,
        shipment_expected_qty: 1,
        received_qty: 1,
        off_manifest_qty: 0,
        marked_missing_qty: 0,
        remaining_missing_qty: 0,
        slip_content_ids: [],
        expected_package_ids: [],
        return_item_ids: [],
        package_ids: ["00000000-0000-0000-0000-000000000003"],
        build_sources: [],
        has_slip: true,
        has_shipment: true,
        receive_finalized: false,
      },
    ],
  });
  assert.equal(review.scope, "box");
  assert.equal(review.bucket_counts.complete, 1);

  const palletReview = buildPalletScopeReview({
    ...review,
    scope: undefined as never,
    package_ids: review.package_ids,
    grains: review.lines.map((l) => ({
      grain_key: l.grain_key,
      grain: l.grain,
      label: l.label,
      slip_qty: l.quantities.slip_qty,
      shipment_expected_qty: l.quantities.shipment_expected_qty,
      received_qty: l.quantities.received_qty,
      off_manifest_qty: l.quantities.off_manifest_qty,
      marked_missing_qty: l.quantities.marked_missing_qty,
      remaining_missing_qty: l.quantities.missing_qty,
      slip_content_ids: l.slip_content_ids,
      expected_package_ids: l.expected_package_ids,
      return_item_ids: l.return_item_ids,
      package_ids: l.package_ids,
      build_sources: l.build_sources,
      has_slip: l.sources.has_slip,
      has_shipment: l.sources.has_shipment,
      receive_finalized: false,
    })),
  });
  assert.equal(palletReview.scope, "pallet");

  const shipmentReview = buildShipmentScopeReview({
    organization_id: review.organization_id,
    store_id: review.store_id,
    package_ids: review.package_ids,
    pallet_id: null,
    tracking_numbers: review.tracking_numbers,
    grains: palletReview.lines.map((l) => ({
      grain_key: l.grain_key,
      grain: l.grain,
      label: l.label,
      slip_qty: l.quantities.slip_qty,
      shipment_expected_qty: l.quantities.shipment_expected_qty,
      received_qty: l.quantities.received_qty,
      off_manifest_qty: l.quantities.off_manifest_qty,
      marked_missing_qty: l.quantities.marked_missing_qty,
      remaining_missing_qty: l.quantities.missing_qty,
      slip_content_ids: l.slip_content_ids,
      expected_package_ids: l.expected_package_ids,
      return_item_ids: l.return_item_ids,
      package_ids: l.package_ids,
      build_sources: l.build_sources,
      has_slip: l.sources.has_slip,
      has_shipment: l.sources.has_shipment,
      receive_finalized: false,
    })),
  });
  assert.equal(shipmentReview.scope, "shipment");
  assert.deepEqual(Object.keys(emptyUnifiedBucketCounts()).sort(), [
    "complete",
    "missing",
    "over",
    "partial",
    "shipment_only",
    "slip_only",
    "unexpected",
  ]);
}

async function main(): Promise<void> {
  const skipBuild = process.argv.includes("--skip-build");
  runUnitTests();
  const sources = verifySources();

  let build_result = "SKIP";
  if (!skipBuild) {
    try {
      execSync("npm run build", { stdio: "pipe", cwd: process.cwd(), timeout: 240_000 });
      build_result = "PASS";
    } catch {
      build_result = "FAIL";
    }
  }

  const review_engine_files = [
    "lib/scanner/review-engine/index.ts",
    "lib/scanner/review-engine/review-engine-types.ts",
    "lib/scanner/review-engine/review-engine-quantities.ts",
    "lib/scanner/review-engine/review-engine-classify.ts",
    "lib/scanner/review-engine/review-engine-aggregate.ts",
    "lib/scanner/review-engine/review-engine-adapters.ts",
  ].filter((f) => existsSync(join(process.cwd(), f)));

  const blockers: string[] = [];
  if (build_result === "FAIL") blockers.push("build failed");
  if (sources.box_review_source === "missing") blockers.push("box review not wired to engine");
  if (sources.pallet_review_source === "missing") blockers.push("pallet review not wired to engine");
  if (sources.shipment_review_source === "missing") blockers.push("shipment review not wired to engine");

  const pass = build_result !== "FAIL" && blockers.length === 0;

  console.log(
    JSON.stringify(
      {
        phase: "PHASE-6D-UNIFIED-REVIEW-ENGINE",
        review_engine_files,
        ...sources,
        build_result,
        SAFE_TO_PUSH: pass ? "yes" : "no",
        blockers,
      },
      null,
      2,
    ),
  );

  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
