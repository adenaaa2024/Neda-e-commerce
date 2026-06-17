/**
 * Smoke — PHASE-CLAIM-TRID-REFERENCE-GRAPH-FINAL-VERIFY-V1 (static checks only)
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { TRID_REFERENCE_GRAPH_VERIFY_V1_VERSION } from "../lib/claims/reference/claim-trid-reference-graph-verify-v1";

const VERIFY_MODULE = "lib/claims/reference/claim-trid-reference-graph-verify-v1.ts";
const VERIFY_SCRIPT = "scripts/phase-claim-trid-reference-graph-final-verify-v1.ts";

function fail(msg: string): never {
  throw new Error(`SMOKE_FAIL: ${msg}`);
}

function main(): void {
  const root = process.cwd();
  if (!fs.existsSync(path.join(root, VERIFY_MODULE))) {
    fail(`missing ${VERIFY_MODULE}`);
  }
  if (!fs.existsSync(path.join(root, VERIFY_SCRIPT))) {
    fail(`missing ${VERIFY_SCRIPT}`);
  }

  const mod = fs.readFileSync(path.join(root, VERIFY_MODULE), "utf8");
  const script = fs.readFileSync(path.join(root, VERIFY_SCRIPT), "utf8");

  if (!mod.includes(TRID_REFERENCE_GRAPH_VERIFY_V1_VERSION)) {
    fail("verify module missing version constant");
  }
  if (!mod.includes("missing_trid_warning")) {
    fail("verify module must emit missing_trid_warning");
  }
  if (!mod.includes("no_source_reference_edge")) {
    fail("verify module must block no_source_reference_edge");
  }
  if (!script.includes("bindProductionSupabaseEnv")) {
    fail("verify script must bind production env");
  }
  if (!script.includes("no_db_write_verification")) {
    fail("verify script must include no_db_write_verification");
  }
  if (!script.includes("SAFE_TRID_REFERENCE_GRAPH_VERIFIED")) {
    fail("verify script must emit SAFE_TRID_REFERENCE_GRAPH_VERIFIED");
  }
  if (script.includes(".insert(") || script.includes(".update(") || script.includes(".delete(")) {
    fail("verify script must not mutate DB");
  }

  console.log(JSON.stringify({ smoke: "pass", version: TRID_REFERENCE_GRAPH_VERIFY_V1_VERSION }));
}

main();
