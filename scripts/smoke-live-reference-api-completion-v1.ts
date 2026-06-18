/**
 * Smoke — PHASE-LIVE-REFERENCE-API-COMPLETION-V1
 * Static contract + guard checks only (no DB).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CLAIM_LIVE_REFERENCE_API_COMPLETION_V1,
  LIVE_SP_API_SYNC_ENABLED,
  REFERENCE_WRITE_ENABLED,
  verifyLiveReferenceApiCompletionContractStatic,
} from "../lib/claims/reference/claim-live-reference-api-completion-v1";

assert.equal(LIVE_SP_API_SYNC_ENABLED, false, "live SP-API sync must be disabled");
assert.equal(REFERENCE_WRITE_ENABLED, false, "reference write must be disabled");
assert.ok(verifyLiveReferenceApiCompletionContractStatic(), "endpoints + contract must exist");

for (const rel of [
  "app/api/claims/center/references/trid-resolver/route.ts",
  "app/api/claims/center/references/refresh-preview/route.ts",
  "app/api/claims/center/references/coverage/route.ts",
  "app/api/claims/center/reimbursement-match/refresh-preview/route.ts",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingReferenceHealthSection.tsx",
]) {
  assert.ok(fs.existsSync(path.join(process.cwd(), rel)), `missing ${rel}`);
}

const drawer = fs.readFileSync(
  path.join(
    process.cwd(),
    "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx",
  ),
  "utf8",
);
assert.match(drawer, /ReimbursementTrackingReferenceHealthSection/, "drawer must render Reference Health");

const refreshRoute = fs.readFileSync(
  path.join(process.cwd(), "app/api/claims/center/references/refresh-preview/route.ts"),
  "utf8",
);
assert.match(refreshRoute, /export async function POST/, "refresh-preview must be POST");

console.log(
  JSON.stringify({
    smoke: "pass",
    version: CLAIM_LIVE_REFERENCE_API_COMPLETION_V1,
    live_sp_api_sync_enabled: LIVE_SP_API_SYNC_ENABLED,
    reference_write_enabled: REFERENCE_WRITE_ENABLED,
  }),
);
