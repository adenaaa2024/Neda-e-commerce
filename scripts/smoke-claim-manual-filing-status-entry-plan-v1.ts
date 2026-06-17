/**
 * Smoke — PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-PLAN-V1 (static contract checks)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAIM_MANUAL_FILING_STATUS_ENTRY_PLAN_V1_VERSION,
  MANUAL_FILING_RECORD_CONFIRMATION_TEXT,
  UI_MODAL_CONTRACT,
} from "../lib/claims/submission/claim-manual-filing-status-entry-plan-v1";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");
const LIB = "lib/claims/submission/claim-manual-filing-status-entry-plan-v1.ts";

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

function main(): void {
  const lib = read(LIB);
  const checks = {
    lib_exists: fs.existsSync(path.join(REPO, LIB)),
    version: lib.includes(CLAIM_MANUAL_FILING_STATUS_ENTRY_PLAN_V1_VERSION),
    modal_action: UI_MODAL_CONTRACT.action_label === "Record manual filing",
    confirmation_text: lib.includes(MANUAL_FILING_RECORD_CONFIRMATION_TEXT),
    submission_id_mapping: lib.includes("claim_submissions.submission_id"),
    no_amazon_api: !lib.includes("amazon-sp-api"),
    audit_event: lib.includes("claim_history_logs"),
    duplicate_rule: lib.includes("claim_submissions_store_external_case_uidx"),
    reimbursement_drawer_target: read(
      "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx",
    ).includes("deriveNextAction"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  console.log(
    JSON.stringify({
      smoke: failures.length === 0 ? "pass" : "fail",
      failures,
      SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI: failures.length === 0 ? "yes" : "no",
    }),
  );
  if (failures.length > 0) process.exitCode = 1;
}

main();
