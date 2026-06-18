/**
 * Smoke: PHASE-CLAIM-PILOT-PREFILING-FINAL-VERIFY-V1
 * Static contract checks only (no DB, no writes).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  verifyClaimPilotPrefilingContractStatic,
  EXPECTED_PILOT_SUBMISSION_COUNT,
} from "../lib/claims/submission/claim-pilot-prefiling-final-verify-v1";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
}

const cwd = process.cwd();

assert(verifyClaimPilotPrefilingContractStatic(), "static contract constants mismatch");
assert(EXPECTED_PILOT_SUBMISSION_COUNT === 10, "expected pilot submission count must be 10");

const libPath = join(cwd, "lib/claims/submission/claim-pilot-prefiling-final-verify-v1.ts");
const scriptPath = join(cwd, "scripts/phase-claim-pilot-prefiling-final-verify-v1.ts");
assert(existsSync(libPath), "verifier lib missing");
assert(existsSync(scriptPath), "verifier script missing");

const scriptSrc = readFileSync(scriptPath, "utf8");
assert(scriptSrc.includes("read-only-verify"), "script must declare read-only-verify mode");
assert(scriptSrc.includes("PRODUCTION_REF"), "script must guard production ref");
assert(
  !/INSERT\s+INTO|\.update\(|\.insert\(|\.delete\(|\.upsert\(/i.test(scriptSrc),
  "verifier script must not contain any write operation",
);
assert(scriptSrc.includes("no_claim_submission_mutation_verification"), "must emit submission mutation guard");
assert(scriptSrc.includes("SAFE_CLAIM_PILOT_PREFILING_PRODUCTION_READY"), "must emit prefiling safe flag");

const libSrc = readFileSync(libPath, "utf8");
assert(
  !/\.update\(|\.insert\(|\.delete\(|\.upsert\(/i.test(libSrc),
  "verifier lib must not contain any write operation",
);
assert(libSrc.includes("composeMoneyLanePreviewAfterCogsV1"), "lib must reuse money lane after COGS composer");
assert(libSrc.includes("composeTridReferenceTraceMatrixV1"), "lib must reuse TRID trace matrix composer");
assert(libSrc.includes("composeClaimFilingPacketPreviewV1"), "lib must reuse filing packet composer");

console.log(
  JSON.stringify(
    { smoke: "PHASE-CLAIM-PILOT-PREFILING-FINAL-VERIFY-V1", result: "pass", checks: 12 },
    null,
    2,
  ),
);
