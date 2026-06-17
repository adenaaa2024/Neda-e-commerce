/**
 * Smoke — PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1 (static checks)
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CLAIM_SUBMISSION_RECORD_PILOT_V1_VERSION,
  SCHEMA_MIGRATION_APPROVAL_TOKEN,
  SUBMISSION_RECORD_PILOT_ORIGIN,
  TRID_REVERIFY_AFTER_7H_PATH,
} from "../lib/claims/submission/claim-submission-record-pilot-v1";

const LIB = "lib/claims/submission/claim-submission-record-pilot-v1.ts";
const SCRIPT = "scripts/phase-claim-submission-record-pilot-execute-v1.ts";

function main(): void {
  const root = process.cwd();
  const lib = fs.readFileSync(path.join(root, LIB), "utf8");
  const script = fs.readFileSync(path.join(root, SCRIPT), "utf8");

  const checks = {
    lib_exists: fs.existsSync(path.join(root, LIB)),
    script_exists: fs.existsSync(path.join(root, SCRIPT)),
    schema_approval_token: lib.includes(SCHEMA_MIGRATION_APPROVAL_TOKEN),
    reverify_path: lib.includes("TRID_REVERIFY_AFTER_7H_PATH"),
    blocked_case_skip: script.includes("blocked_case"),
    migration_status_output: script.includes("migration_status"),
    execute_flag_guard: script.includes("--execute"),
    no_amazon: !script.includes("amazon-sp-api"),
    no_hard_delete: !script.includes(".delete("),
    rollback_output: script.includes("rollback.sql"),
    safe_reimbursement_gate: script.includes("SAFE_TO_BUILD_REIMBURSEMENT_TRACKING_PREVIEW"),
    origin_constant: lib.includes(SUBMISSION_RECORD_PILOT_ORIGIN),
    version_constant: lib.includes(CLAIM_SUBMISSION_RECORD_PILOT_V1_VERSION),
    reverify_default_path: lib.includes(TRID_REVERIFY_AFTER_7H_PATH),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  console.log(
    JSON.stringify({
      smoke: failures.length === 0 ? "pass" : "fail",
      version: CLAIM_SUBMISSION_RECORD_PILOT_V1_VERSION,
      failures,
    }),
  );
  if (failures.length > 0) process.exitCode = 1;
}

main();
