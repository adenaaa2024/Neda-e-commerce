/**
 * Smoke: PHASE-TRID-REFERENCE-TRACE-MATRIX-V1 static contract checks (no DB).
 *   npx tsx scripts/smoke-trid-reference-trace-matrix-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  EVENT_DATETIME_FILTER_USED,
  TRID_REFERENCE_TRACE_MATRIX_V1,
} from "../lib/claims/reference/trid-reference-trace-matrix-v1";

function fileExists(rel: string): boolean {
  return fs.existsSync(path.join(process.cwd(), rel));
}

function main(): void {
  const checks: Array<{ name: string; ok: boolean }> = [
    { name: "version_constant", ok: TRID_REFERENCE_TRACE_MATRIX_V1 === "trid-reference-trace-matrix-v1" },
    { name: "event_datetime_filter_disabled", ok: EVENT_DATETIME_FILTER_USED === false },
    { name: "composer_lib_exists", ok: fileExists("lib/claims/reference/trid-reference-trace-matrix-v1.ts") },
    { name: "phase_script_exists", ok: fileExists("scripts/phase-trid-reference-trace-matrix-v1.ts") },
    { name: "trid_resolver_lib_exists", ok: fileExists("lib/claims/reference/claim-live-reference-api-completion-v1.ts") },
    { name: "case_review_readmodel_exists", ok: fileExists("lib/claims/pilot/claim-case-review-readmodel.ts") },
  ];

  const failed = checks.filter((c) => !c.ok);
  const out = {
    smoke: failed.length === 0 ? "pass" : "fail",
    checks,
    failed: failed.map((c) => c.name),
  };
  console.log(JSON.stringify(out, null, 2));
  if (failed.length > 0) process.exit(1);
}

main();
