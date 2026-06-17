/**
 * Smoke — PHASE-CLAIM-LIVE-REFERENCE-API-COMPLETION-AUDIT-V1
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CLAIM_LIVE_REFERENCE_API_COMPLETION_AUDIT_V1,
  verifyLiveReferenceAuditContractStatic,
} from "../lib/claims/reference/claim-live-reference-api-completion-audit-v1";

assert.ok(verifyLiveReferenceAuditContractStatic());

const phaseScript = fs.readFileSync(
  path.join(process.cwd(), "scripts/phase-claim-live-reference-api-completion-audit-v1.ts"),
  "utf8",
);
assert.match(phaseScript, /live-reference-api-completion-audit/);
assert.match(phaseScript, /SAFE_TO_BUILD_LIVE_REFERENCE_API_LAYER/);
assert.match(phaseScript, /reference_coverage_matrix/);

console.log(
  JSON.stringify({
    smoke: "pass",
    version: CLAIM_LIVE_REFERENCE_API_COMPLETION_AUDIT_V1,
    SAFE_LIVE_REFERENCE_AUDIT_CONTRACT: "ok",
  }),
);
