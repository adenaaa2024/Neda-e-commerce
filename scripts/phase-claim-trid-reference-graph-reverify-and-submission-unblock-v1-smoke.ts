/**
 * Smoke for PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AND-SUBMISSION-UNBLOCK-V1
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SCRIPT = "scripts/phase-claim-trid-reference-graph-reverify-and-submission-unblock-v1.ts";
const LIB = "lib/claims/submission/claim-submission-record-pilot-v1.ts";

function main(): void {
  const cwd = process.cwd();
  if (!fs.existsSync(path.join(cwd, SCRIPT))) throw new Error(`missing ${SCRIPT}`);
  if (!fs.existsSync(path.join(cwd, LIB))) throw new Error(`missing ${LIB}`);
  const src = fs.readFileSync(path.join(cwd, SCRIPT), "utf8");
  if (!src.includes("SAFE_TO_EXECUTE_CLAIM_SUBMISSION_RECORD_PILOT")) {
    throw new Error("script missing SAFE_TO_EXECUTE gate");
  }
  if (!src.includes("claim_submissions_migration_status")) {
    throw new Error("script missing migration status output");
  }
  console.log(JSON.stringify({ ok: true, smoke: "phase-claim-trid-reference-graph-reverify-and-submission-unblock-v1" }));
}

main();
