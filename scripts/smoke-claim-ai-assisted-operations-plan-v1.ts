/**
 * Smoke — PHASE-CLAIM-AI-ASSISTED-OPERATIONS-PLAN-V1
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CLAIM_AI_ASSISTED_OPERATIONS_PLAN_V1,
  buildClaimAiAssistedOperationsPlanV1,
  verifyAiAssistedOperationsPlanStatic,
} from "../lib/claims/ai/claim-ai-assisted-operations-plan-v1";

assert.ok(verifyAiAssistedOperationsPlanStatic());

const plan = buildClaimAiAssistedOperationsPlanV1();
assert.equal(plan.recommended_ai_features.length, 6);
assert.ok(plan.rejected_ai_features.some((r) => r.id === "ai_auto_amazon_submit"));
assert.ok(plan.safe_ai_boundaries.length >= 8);
assert.equal(plan.no_db_write_verification, true);

const phaseScript = fs.readFileSync(
  path.join(process.cwd(), "scripts/phase-claim-ai-assisted-operations-plan-v1.ts"),
  "utf8",
);
assert.match(phaseScript, /ai-assisted-operations-plan/);
assert.match(phaseScript, /SAFE_TO_BUILD_AI_EVIDENCE_SUMMARY/);

console.log(
  JSON.stringify({
    smoke: "pass",
    version: CLAIM_AI_ASSISTED_OPERATIONS_PLAN_V1,
    SAFE_AI_PLAN_CONTRACT: "ok",
  }),
);
