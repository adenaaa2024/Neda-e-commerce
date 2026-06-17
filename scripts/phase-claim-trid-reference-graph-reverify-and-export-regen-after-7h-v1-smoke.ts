/**
 * Smoke — PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AND-EXPORT-REGEN-AFTER-7H-V1
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  TRID_REFERENCE_GRAPH_REVERIFY_EXPORT_REGEN_AFTER_7H_V1_VERSION,
} from "../lib/claims/reference/claim-trid-reference-graph-reverify-after-7h-v1";

const LIB = "lib/claims/reference/claim-trid-reference-graph-reverify-after-7h-v1.ts";
const SCRIPT = "scripts/phase-claim-trid-reference-graph-reverify-and-export-regen-after-7h-v1.ts";

function main(): void {
  const root = process.cwd();
  const lib = fs.readFileSync(path.join(root, LIB), "utf8");
  const script = fs.readFileSync(path.join(root, SCRIPT), "utf8");

  const checks = {
    lib_exists: fs.existsSync(path.join(root, LIB)),
    script_exists: fs.existsSync(path.join(root, SCRIPT)),
    version: lib.includes(TRID_REFERENCE_GRAPH_REVERIFY_EXPORT_REGEN_AFTER_7H_V1_VERSION),
    original_7h_evidence: lib.includes("findPhase7hOriginalExecuteEvidence"),
    export_regen: script.includes("exportPilotBatch"),
    draft_labels: script.includes("REQUIRED_DRAFT_LABELS"),
    no_db_insert: !script.includes('.insert('),
    safe_execute_gate: script.includes("SAFE_TO_EXECUTE_CLAIM_SUBMISSION_RECORD_PILOT"),
    export_verify: lib.includes("verifyRegeneratedExportReferences"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  console.log(JSON.stringify({ smoke: failures.length === 0 ? "pass" : "fail", failures }));
  if (failures.length > 0) process.exitCode = 1;
}

main();
