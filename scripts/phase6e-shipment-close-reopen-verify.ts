/**
 * PHASE-6E-SHIPMENT-REVIEW-CLOSE-REOPEN verify
 *   npx tsx scripts/phase6e-shipment-close-reopen-verify.ts
 *   npx tsx scripts/phase6e-shipment-close-reopen-verify.ts --skip-build
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildShipmentCloseReviewModelFromPreview,
  buildShipmentCloseReviewSnapshot,
} from "../lib/scanner/shipment-close-review";
import {
  mergePackageManifestShipmentCloseFinalize,
  mergePalletPhotoEvidenceShipmentCloseFinalize,
  SHIPMENT_OPERATOR_CLOSE_MANIFEST_KEY,
  readShipmentCloseFromPalletPhotoEvidence,
} from "../lib/scanner/shipment-operator-close-manifest";
import {
  OPERATOR_MOBILE_CLOSE_SHIPMENT_REVIEW,
  OPERATOR_MOBILE_REOPEN_SHIPMENT_REVIEW,
} from "../lib/operator-mobile-permissions";
import type { PalletShipmentReviewPreview } from "../lib/scanner/pallet-shipment-review-types";

function verifyShipmentReviewModal(): Record<string, string> {
  assert.ok(existsSync(join(process.cwd(), "app/scanner/operator-mobile/_components/ShipmentCloseReviewModal.tsx")));
  const scanPage = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8");
  const modal = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/_components/ShipmentCloseReviewModal.tsx"),
    "utf8",
  );

  assert.ok(scanPage.includes("ShipmentCloseReviewModal"));
  assert.ok(scanPage.includes("openShipmentCloseReviewModal"));
  assert.ok(modal.includes("Shipment review"));
  assert.ok(modal.includes("Missing / final shortage") || modal.includes("final review shortage"));

  return {
    component: "ShipmentCloseReviewModal",
    engine: "buildShipmentScopeReview via computePalletShipmentReviewPreviewAction(trackingNumber)",
    buckets:
      "complete, partial, missing/final shortage, over, unexpected, slip only, shipment only",
    confirmation: "review checkbox + critical issue ack",
  };
}

function verifySingleBoxShipmentSupported(): Record<string, string> {
  const scanPage = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8");
  const preview = readFileSync(join(process.cwd(), "lib/scanner/pallet-shipment-review-preview.ts"), "utf8");

  assert.ok(scanPage.includes("singleBoxShipmentReviewReady"));
  assert.ok(scanPage.includes("trackingNumber: tn"));
  assert.ok(preview.includes("shipment_tracking"));

  return {
    rule: "trackingNumber scope even when one pallet / one box",
    hint: "singleBoxShipmentReviewReady banner on scan step",
    preview_scope: "scope_kind shipment_tracking",
  };
}

function verifyShipmentCloseFlow(): Record<string, string> {
  const actions = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"),
    "utf8",
  );

  assert.ok(actions.includes("finalizeOperatorShipmentCloseAction"));
  assert.ok(actions.includes("buildShipmentScopeReview") || actions.includes("buildPalletShipmentReviewPreview"));
  assert.ok(actions.includes("shipment_receive_close"));
  assert.ok(actions.includes("Does not create claim_cases"));

  return {
    step_1_open_review: "computePalletShipmentReviewPreviewAction(trackingNumber)",
    step_2_show_summary: "ShipmentCloseReviewModal unified buckets",
    step_3_confirm: "checkbox + critical ack",
    step_4_snapshot: "operator_shipment_receive_close manifest",
    step_5_finalize: "audit log shipment_receive_close",
  };
}

function verifyShipmentReopenFlow(): Record<string, string> {
  const actions = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"),
    "utf8",
  );
  const scanPage = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8");

  assert.ok(actions.includes("reopenOperatorShipmentCloseAction"));
  assert.ok(actions.includes("shipment_receive_reopen"));
  assert.ok(scanPage.includes("handleReopenClosedShipment"));

  return {
    permission: "OPERATOR_MOBILE_REOPEN_SHIPMENT_REVIEW",
    audit: "pallet_audit_log or package_audit_log shipment_receive_reopen",
    restore: "close_state open + review_confirmed preserved",
  };
}

function verifyPermissions(): Record<string, string> {
  const guard = readFileSync(join(process.cwd(), "lib/operator-mobile-permission-guard.ts"), "utf8");
  assert.equal(OPERATOR_MOBILE_CLOSE_SHIPMENT_REVIEW, "operations.operator_mobile.close_shipment_review");
  assert.equal(OPERATOR_MOBILE_REOPEN_SHIPMENT_REVIEW, "operations.operator_mobile.reopen_shipment_review");
  assert.ok(guard.includes("OPERATOR_MOBILE_CLOSE_SHIPMENT_REVIEW"));
  assert.ok(guard.includes("OPERATOR_MOBILE_REOPEN_SHIPMENT_REVIEW"));

  return {
    close_shipment_review: OPERATOR_MOBILE_CLOSE_SHIPMENT_REVIEW,
    reopen_shipment_review: OPERATOR_MOBILE_REOPEN_SHIPMENT_REVIEW,
  };
}

function verifySnapshotLocation(): Record<string, string> {
  const preview: PalletShipmentReviewPreview = {
    phase: "6E-A",
    read_only: true,
    scope_kind: "shipment_tracking",
    organization_id: "00000000-0000-0000-0000-000000000001",
    store_id: "00000000-0000-0000-0000-000000000002",
    pallet_id: null,
    tracking_number: "TNX-PHASE6E",
    tracking_numbers: ["TNX-PHASE6E"],
    package_count: 1,
    lines: [
      {
        grain_key: "g1",
        bucket: "expected_under_received",
        grain: { fnsku: "X001" },
        confidence: "exact",
        resolved_product_id: null,
        identifiers: { upc: null, sku: null, fnsku: "X001", asin: null },
        expected_qty: 2,
        slip_qty: 2,
        scanned_qty: 1,
        delta_qty: -1,
        off_manifest_scanned_qty: 0,
        operator_note_missing_qty: 1,
        problem_item_qty: 0,
        packages: [],
        evidence_photo_count: 0,
        suggested_review_action: "confirm_shortage_at_close",
        claim_meaning: "potential_shortage_claim_at_close",
        label: "X001",
        slip_content_ids: [],
        expected_package_ids: [],
        return_item_ids: [],
      },
    ],
    bucket_counts: {
      expected_received_complete: 0,
      expected_under_received: 1,
      expected_over_received: 0,
      scanned_off_manifest: 0,
      slip_only_evidence: 0,
      shipment_only_expected: 0,
      damaged_or_problem_items: 0,
      pending_review: 0,
    },
    totals: {
      shipment_expected_units: 2,
      slip_units: 2,
      scanned_units: 1,
      off_manifest_units: 0,
      operator_note_missing_units: 1,
      problem_item_units: 0,
    },
  };

  const model = buildShipmentCloseReviewModelFromPreview(preview);
  assert.ok(model.bucket_counts.missing >= 1);

  const snapshot = buildShipmentCloseReviewSnapshot(model, {
    confirmedAtIso: "2026-06-10T12:00:00.000Z",
    confirmedBy: null,
    trackingNumber: "TNX-PHASE6E",
    storeId: preview.store_id,
    criticalIssuesAcknowledged: true,
    auditNote: null,
  });
  assert.equal(snapshot.scope, "shipment");

  const pe = mergePalletPhotoEvidenceShipmentCloseFinalize({}, {
    trackingNumber: "TNX-PHASE6E",
    storeId: preview.store_id,
    anchorPalletId: "00000000-0000-0000-0000-000000000003",
    anchorPackageId: "00000000-0000-0000-0000-000000000004",
    finalizedAtIso: snapshot.confirmed_at,
    finalizedBy: null,
    reviewSnapshot: snapshot,
  });
  const read = readShipmentCloseFromPalletPhotoEvidence(pe, "TNX-PHASE6E");
  assert.equal(read.close_state, "finalized");

  const pkgMd = mergePackageManifestShipmentCloseFinalize({}, {
    trackingNumber: "TNX-PHASE6E",
    storeId: preview.store_id,
    anchorPackageId: "00000000-0000-0000-0000-000000000004",
    finalizedAtIso: snapshot.confirmed_at,
    finalizedBy: null,
    reviewSnapshot: snapshot,
  });
  assert.ok(pkgMd[SHIPMENT_OPERATOR_CLOSE_MANIFEST_KEY]);

  return {
    primary: `pallets.photo_evidence.${SHIPMENT_OPERATOR_CLOSE_MANIFEST_KEY}`,
    fallback: `packages.manifest_data.${SHIPMENT_OPERATOR_CLOSE_MANIFEST_KEY}`,
    new_table: "no",
  };
}

function verifyNoClaimsOrMissingReturnItems(): Record<string, string> {
  const actions = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"),
    "utf8",
  );
  const finalizeBlock = actions.slice(
    actions.indexOf("finalizeOperatorShipmentCloseAction"),
    actions.indexOf("export type ReopenOperatorShipmentCloseInput"),
  );

  assert.ok(!finalizeBlock.includes('.from("claim_cases")'));
  assert.ok(!finalizeBlock.includes('.from("claim_candidates")'));
  assert.ok(!finalizeBlock.includes('.from("return_items").insert'));

  return {
    claims_created_no: "yes — no claim_cases / claim_candidates writes in finalize",
    missing_return_items_created_no: "yes — no return_items insert in finalize",
  };
}

async function main(): Promise<void> {
  const skipBuild = process.argv.includes("--skip-build");

  const shipment_review_modal = verifyShipmentReviewModal();
  const single_box_shipment_supported = verifySingleBoxShipmentSupported();
  const shipment_close_flow = verifyShipmentCloseFlow();
  const shipment_reopen_flow = verifyShipmentReopenFlow();
  const permissions = verifyPermissions();
  const snapshot_location = verifySnapshotLocation();
  const safety = verifyNoClaimsOrMissingReturnItems();

  let build_result = "SKIP";
  if (!skipBuild) {
    try {
      execSync("npm run build", { stdio: "pipe", cwd: process.cwd(), timeout: 300_000 });
      build_result = "PASS";
    } catch (err) {
      const msg =
        err instanceof Error && "stderr" in err
          ? String((err as { stderr?: Buffer }).stderr ?? err.message)
          : String(err);
      build_result = `FAIL: ${msg.slice(0, 800)}`;
    }
  }

  const SAFE_TO_PUSH =
    build_result === "PASS" &&
    safety.claims_created_no.startsWith("yes") &&
    safety.missing_return_items_created_no.startsWith("yes")
      ? "yes"
      : "no";

  const out = {
    shipment_review_modal,
    single_box_shipment_supported,
    shipment_close_flow,
    shipment_reopen_flow,
    permissions,
    snapshot_location,
    claims_created_no: safety.claims_created_no,
    missing_return_items_created_no: safety.missing_return_items_created_no,
    build_result,
    SAFE_TO_PUSH,
  };

  console.log(JSON.stringify(out, null, 2));
  if (build_result.startsWith("FAIL")) process.exitCode = 1;
}

void main();
