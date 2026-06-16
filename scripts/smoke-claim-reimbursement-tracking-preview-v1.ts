/**
 * Smoke — PHASE-CLAIM-REIMBURSEMENT-TRACKING-PREVIEW-V1 (static checks)
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CLAIM_REIMBURSEMENT_TRACKING_PREVIEW_V1_VERSION,
} from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";

const LIB = "lib/claims/submission/claim-reimbursement-tracking-preview-v1.ts";
const SCRIPT = "scripts/phase-claim-reimbursement-tracking-preview-v1.ts";

function main(): void {
  const root = process.cwd();
  const lib = fs.readFileSync(path.join(root, LIB), "utf8");
  const script = fs.readFileSync(path.join(root, SCRIPT), "utf8");

  const checks = {
    lib_exists: fs.existsSync(path.join(root, LIB)),
    script_exists: fs.existsSync(path.join(root, SCRIPT)),
    no_db_insert: !script.includes(".insert(") && !lib.includes(".insert("),
    no_db_update: !script.includes(".update(") && !lib.includes(".update("),
    no_amazon_api: !script.includes("amazon-sp-api"),
    pilot_origin_filter:
      lib.includes("SUBMISSION_RECORD_PILOT_ORIGIN") ||
      lib.includes("manual_filing_record_pilot_v1"),
    legacy_excluded: lib.includes("excluded_from_pilot_preview"),
    reimbursement_status_enum: lib.includes("draft_not_filed"),
    match_confidence: lib.includes("deriveMatchConfidence"),
    summary_cards: script.includes("summary_cards"),
    money_null_verify: lib.includes("verifyMoneyNullPreservationTracking"),
    safe_flags: script.includes("SAFE_REIMBURSEMENT_TRACKING_PREVIEW_READY"),
    version_constant: lib.includes(CLAIM_REIMBURSEMENT_TRACKING_PREVIEW_V1_VERSION),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  console.log(
    JSON.stringify({
      smoke: failures.length === 0 ? "pass" : "fail",
      version: CLAIM_REIMBURSEMENT_TRACKING_PREVIEW_V1_VERSION,
      failures,
    }),
  );
  if (failures.length > 0) process.exitCode = 1;
}

main();
