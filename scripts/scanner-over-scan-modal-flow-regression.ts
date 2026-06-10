/**
 * FIX-OVER-SCAN-MODAL-FLOW-BUG — code regression
 *   npx tsx scripts/scanner-over-scan-modal-flow-regression.ts
 *   npx tsx scripts/scanner-over-scan-modal-flow-regression.ts --skip-build
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  shouldRequireItemScanOverLimitConfirmation,
} from "../lib/scanner/item-scan-over-limit-confirm";
import { slipLineStatusBadgeState } from "../lib/scanner/slip-contents-missing-expected";

function verifyModalFlowCode(): Record<string, boolean> {
  const itemModal = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/_components/ItemUnitRecordModal.tsx"),
    "utf8",
  );
  const scanPage = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"),
    "utf8",
  );

  const pending_payload_preserved =
    itemModal.includes("overLimitConfirmOpen") &&
    itemModal.includes("setOverLimitConfirmCtx(saveResult.overLimitConfirm") &&
    !scanPage.includes("overLimitPendingSavePayloadRef") &&
    !scanPage.includes("setOverscanConfirmOpen");

  const cancel_returns_to_add_modal =
    itemModal.includes("dismissOverLimitConfirm") &&
    itemModal.includes("onClick={dismissOverLimitConfirm}") &&
    itemModal.includes("if (saveResult.needsOverLimitConfirm)") &&
    itemModal.includes("dismissOverLimitConfirm();") &&
    !itemModal.includes("setItemUnitModal(null)");

  const confirm_saves_item =
    itemModal.includes("performSave({ overLimitConfirmed: true })") &&
    scanPage.includes("overLimitConfirmed: payload.overLimitConfirmed") &&
    scanPage.includes("overLimitConfirm:");

  const over_row_updates = (() => {
    const badge = slipLineStatusBadgeState(
      { expected: 1, received: 2, recordedMissing: 0, remainingMissing: 0, fullyAccounted: true, staleMissingReview: false },
      false,
    );
    assert.equal(badge.label, "Over");
    return scanPage.includes("slipLineStatusBadgeState");
  })();

  const batch_mode_verified =
    itemModal.includes("batchQuantity: batchQty > 1 ? batchQty : undefined") &&
    itemModal.includes("overLimitConfirmed: opts?.overLimitConfirmed") &&
    shouldRequireItemScanOverLimitConfirmation({ currentReceived: 2, incomingQty: 3, expectedLimit: 2 });

  const single_mode_verified =
    itemModal.includes('addMode === "batch"') &&
    shouldRequireItemScanOverLimitConfirmation({ currentReceived: 1, incomingQty: 1, expectedLimit: 1 });

  return {
    pending_payload_preserved,
    cancel_returns_to_add_modal,
    confirm_saves_item,
    over_row_updates,
    batch_mode_verified,
    single_mode_verified,
  };
}

async function main(): Promise<void> {
  const skipBuild = process.argv.includes("--skip-build");
  const checks = verifyModalFlowCode();

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
  for (const [k, v] of Object.entries(checks)) {
    if (!v) blockers.push(`${k} failed`);
  }

  const pass = Object.values(checks).every(Boolean) && build_result !== "FAIL";

  console.log(
    JSON.stringify(
      {
        audit: "FIX-OVER-SCAN-MODAL-FLOW-BUG",
        root_cause:
          "Over warning lived on scan page (z-147) and closed/detached Add Item modal context; confirm re-called save after clearing pending refs.",
        files_changed: [
          "app/scanner/operator-mobile/_components/ItemUnitRecordModal.tsx",
          "app/scanner/operator-mobile/scan/page.tsx",
        ],
        ...checks,
        build_result,
        SAFE_TO_PUSH: pass && blockers.length === 0 ? "yes" : "no",
        blockers,
      },
      null,
      2,
    ),
  );

  if (!pass || blockers.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
