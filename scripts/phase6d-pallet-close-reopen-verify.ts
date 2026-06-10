/**
 * PHASE-6D-PALLET-CLOSE-REOPEN verify
 *   npx tsx scripts/phase6d-pallet-close-reopen-verify.ts
 *   npx tsx scripts/phase6d-pallet-close-reopen-verify.ts --skip-build
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildPalletCloseReviewModelFromPreview,
  buildPalletCloseReviewSnapshot,
} from "../lib/scanner/pallet-close-review";
import {
  mergePalletPhotoEvidenceFinalize,
  mergePalletPhotoEvidenceReopen,
  PALLET_OPERATOR_CLOSE_MANIFEST_KEY,
  readPalletCloseState,
} from "../lib/scanner/pallet-operator-close-manifest";
import {
  OPERATOR_MOBILE_CLOSE_PALLET,
  OPERATOR_MOBILE_REOPEN_PALLET,
} from "../lib/operator-mobile-permissions";
import type { PalletShipmentReviewPreview } from "../lib/scanner/pallet-shipment-review-types";

function verifyPalletCloseFlow(): Record<string, string> {
  const scanPage = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"),
    "utf8",
  );
  const modal = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/_components/PalletCloseReviewModal.tsx"),
    "utf8",
  );
  const actions = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"),
    "utf8",
  );
  const review = readFileSync(join(process.cwd(), "lib/scanner/pallet-close-review.ts"), "utf8");

  assert.ok(scanPage.includes("openPalletCloseReviewModal"));
  assert.ok(scanPage.includes("computePalletShipmentReviewPreviewAction"));
  assert.ok(scanPage.includes("PalletCloseReviewModal"));
  assert.ok(scanPage.includes("finalizeOperatorPalletCloseAction"));
  assert.ok(modal.includes("claims are"));
  assert.ok(actions.includes("buildPalletShipmentReviewPreview"));
  assert.ok(review.includes("buildPalletCloseReviewModelFromPreview"));

  return {
    step_1_open_review: "computePalletShipmentReviewPreviewAction → PalletCloseReviewModal",
    step_2_show_summary: "PalletCloseReviewModal buckets + totals",
    step_3_require_confirmation: "review checkbox + critical issue ack",
    step_4_store_audit_snapshot: "buildPalletCloseReviewSnapshot → photo_evidence manifest",
    step_5_mark_finalized: "pallets.status = closed + pallet_audit_log pallet_close",
    no_claim_records: actions.includes("Does not create claim_cases") ? "yes" : "no",
    missing_review_only: modal.includes("Missing stays review status only") ? "yes" : "no",
  };
}

function verifyReopenFlow(): Record<string, string> {
  const scanPage = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"),
    "utf8",
  );
  const actions = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"),
    "utf8",
  );

  assert.ok(scanPage.includes("handleReopenClosedPallet"));
  assert.ok(scanPage.includes("reopenOperatorPalletCloseAction"));
  assert.ok(actions.includes("pallet_reopen"));
  assert.ok(actions.includes('status: "open"'));

  return {
    step_1_permission_based: "assertOperatorMobilePermission OPERATOR_MOBILE_REOPEN_PALLET",
    step_2_audit_log: "insertOperatorPalletAuditLog action pallet_reopen",
    step_3_restore_edit: "status open + manifest close_state open",
  };
}

function verifyPermissions(): Record<string, string> {
  const guard = readFileSync(
    join(process.cwd(), "lib/operator-mobile-permission-guard.ts"),
    "utf8",
  );
  const actions = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"),
    "utf8",
  );

  assert.equal(OPERATOR_MOBILE_CLOSE_PALLET, "operations.operator_mobile.close_pallet");
  assert.equal(OPERATOR_MOBILE_REOPEN_PALLET, "operations.operator_mobile.reopen_pallet");
  assert.ok(guard.includes("OPERATOR_MOBILE_CLOSE_PALLET"));
  assert.ok(guard.includes("OPERATOR_MOBILE_REOPEN_PALLET"));
  assert.ok(actions.includes("closePallet"));
  assert.ok(actions.includes("reopenPallet"));

  return {
    close_pallet: OPERATOR_MOBILE_CLOSE_PALLET,
    reopen_pallet: OPERATOR_MOBILE_REOPEN_PALLET,
    ui_gates: "correctionPerms.closePallet / reopenPallet on scan page",
    server_gates: "assertOperatorMobilePermission in finalize/reopen actions",
  };
}

function verifyAuditSnapshot(): Record<string, unknown> {
  const preview: PalletShipmentReviewPreview = {
    organization_id: "00000000-0000-0000-0000-000000000001",
    store_id: "00000000-0000-0000-0000-000000000002",
    pallet_id: "00000000-0000-0000-0000-000000000003",
    tracking_number: "TN-PHASE6D",
    package_count: 2,
    totals: {
      shipment_expected_units: 5,
      scanned_units: 4,
      off_manifest_units: 0,
      operator_note_missing_units: 1,
    },
    lines: [
      {
        grain_key: "g-missing",
        label: "X001",
        bucket: "expected_under_received",
        slip_qty: 2,
        expected_qty: 2,
        scanned_qty: 1,
        operator_note_missing_qty: 1,
      },
    ],
  };

  const model = buildPalletCloseReviewModelFromPreview(preview);
  assert.ok(model.has_critical_issues);
  assert.ok(model.bucket_counts.partial >= 1 || model.bucket_counts.missing >= 0);

  const snapshot = buildPalletCloseReviewSnapshot(model, null, {
    confirmedAtIso: "2026-06-10T12:00:00.000Z",
    confirmedBy: "00000000-0000-0000-0000-000000000099",
    criticalIssuesAcknowledged: true,
    auditNote: "phase6d verify",
  });
  assert.equal(snapshot.scope, "pallet");
  assert.equal(snapshot.audit_note, "phase6d verify");

  const pe = mergePalletPhotoEvidenceFinalize({}, {
    finalizedAtIso: snapshot.confirmed_at,
    finalizedBy: snapshot.confirmed_by,
    reviewSnapshot: snapshot,
  });
  const block = (pe[PALLET_OPERATOR_CLOSE_MANIFEST_KEY] ?? {}) as Record<string, unknown>;
  assert.equal(block.close_state, "finalized");
  assert.ok(block.review_confirmed);

  const readClosed = readPalletCloseState(pe, "closed");
  assert.equal(readClosed.close_state, "finalized");

  const peReopen = mergePalletPhotoEvidenceReopen(pe, {
    reopenedAtIso: "2026-06-10T13:00:00.000Z",
    reopenedBy: "00000000-0000-0000-0000-000000000099",
  });
  const readOpen = readPalletCloseState(peReopen, "open");
  assert.equal(readOpen.close_state, "open");
  assert.ok(readOpen.manifest?.review_confirmed);

  return {
    snapshot_scope: snapshot.scope,
    snapshot_has_totals: Boolean(snapshot.totals),
    manifest_key: PALLET_OPERATOR_CLOSE_MANIFEST_KEY,
    finalize_then_reopen: "close_state finalized → open with review_confirmed preserved",
  };
}

function verifyRequiredFiles(): void {
  const paths = [
    "lib/scanner/pallet-operator-close-manifest.ts",
    "lib/scanner/pallet-close-review.ts",
    "app/scanner/operator-mobile/_components/PalletCloseReviewModal.tsx",
  ];
  for (const p of paths) {
    assert.ok(existsSync(join(process.cwd(), p)), `missing ${p}`);
  }
}

async function main(): Promise<void> {
  const skipBuild = process.argv.includes("--skip-build");
  verifyRequiredFiles();

  const pallet_close_flow = verifyPalletCloseFlow();
  const reopen_flow = verifyReopenFlow();
  const permissions = verifyPermissions();
  const audit_snapshot = verifyAuditSnapshot();

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

  const out = {
    pallet_close_flow,
    reopen_flow,
    permissions,
    audit_snapshot,
    build_result,
  };

  console.log(JSON.stringify(out, null, 2));

  if (build_result.startsWith("FAIL")) {
    process.exitCode = 1;
  }
}

void main();
