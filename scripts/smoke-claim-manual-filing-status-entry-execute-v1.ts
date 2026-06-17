/**
 * Smoke — PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  MANUAL_FILING_STATUS_ENTRY_EXECUTE_V1,
  verifyManualFilingExecuteContractStatic,
} from "../lib/claims/submission/claim-manual-filing-status-entry-execute-v1";

assert.ok(verifyManualFilingExecuteContractStatic());

const phaseScript = fs.readFileSync(
  path.join(process.cwd(), "scripts/phase-claim-manual-filing-status-entry-execute-v1.ts"),
  "utf8",
);
assert.match(phaseScript, /phase-claim-manual-filing-status-entry-execute-v1/);
assert.match(phaseScript, /runManualFilingStatusEntryExecuteV1/);
assert.match(phaseScript, /legacy_submissions_untouched_verification/);

const executeLib = fs.readFileSync(
  path.join(process.cwd(), "lib/claims/submission/claim-manual-filing-status-entry-execute-v1.ts"),
  "utf8",
);
assert.match(executeLib, /MANUAL_FILING_WRITE_APPROVAL_KEY/);
assert.match(executeLib, /operator_already_filed_in_seller_central/);
assert.match(executeLib, /attemptGuardedManualFilingExecuteV1/);
assert.match(phaseScript, /SAFE_MANUAL_FILING_STATUS_ENTRY_EXECUTED/);

const guardedLib = fs.readFileSync(
  path.join(process.cwd(), "lib/claims/submission/claim-manual-filing-status-entry-guarded-execute-v1.ts"),
  "utf8",
);
assert.match(guardedLib, /manual_filing_recorded:\s*true/);
assert.match(guardedLib, /external_platform:\s*"amazon_seller_central"/);
assert.doesNotMatch(guardedLib, /amazon-sp-api/);

console.log(
  JSON.stringify({
    smoke: "pass",
    phase: MANUAL_FILING_STATUS_ENTRY_EXECUTE_V1.phase,
    SAFE_MANUAL_FILING_EXECUTE_CONTRACT: "ok",
  }),
);
