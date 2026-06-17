/**
 * Smoke — PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1 (static checks)
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CLAIM_SUBMISSION_RECORD_PILOT_V1_VERSION,
  SUBMISSION_RECORD_PILOT_ORIGIN,
} from "../lib/claims/submission/claim-submission-record-pilot-v1";

const LIB = "lib/claims/submission/claim-submission-record-pilot-v1.ts";
const SCRIPT = "scripts/phase-claim-submission-record-pilot-v1.ts";
const MIGRATION = "supabase/migrations/20260918120000_phase_claim_submission_record_pilot_v1_anchor.sql";
const APPROVAL = ".cursor/operator-approvals/claim-submission-record-pilot-v1-approval.md";

function main(): void {
  const root = process.cwd();
  const lib = fs.readFileSync(path.join(root, LIB), "utf8");
  const script = fs.readFileSync(path.join(root, SCRIPT), "utf8");

  const checks = {
    lib_exists: fs.existsSync(path.join(root, LIB)),
    script_exists: fs.existsSync(path.join(root, SCRIPT)),
    migration_exists: fs.existsSync(path.join(root, MIGRATION)),
    approval_template_exists: fs.existsSync(path.join(root, APPROVAL)),
    version_constant: lib.includes(CLAIM_SUBMISSION_RECORD_PILOT_V1_VERSION),
    origin_constant: lib.includes(SUBMISSION_RECORD_PILOT_ORIGIN),
    idempotency_pattern: lib.includes("manual-filing-v1:"),
    not_submitted_flag: lib.includes("not_submitted_to_amazon"),
    rollback_sql_builder: lib.includes("buildSubmissionRecordPilotRollbackSql"),
    script_dry_run: script.includes("--dry-run") && script.includes("--execute"),
    script_approval_guard: script.includes("readSubmissionRecordApprovalStatus"),
    script_no_amazon: !script.includes("amazon-sp-api"),
    script_no_scanner: !script.includes("operator-mobile"),
    script_rollback_output: script.includes("rollback.sql"),
    no_hard_delete: !script.includes(".delete("),
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
