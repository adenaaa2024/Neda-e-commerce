/**
 * Smoke — PHASE-7H pilot reference edge materialization original execute
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  PILOT_EDGE_APPROVAL_TOKEN,
  PILOT_EDGE_MATERIALIZATION_ORIGIN,
  PILOT_EDGE_SCHEMA_MIGRATION_APPROVAL_TOKEN,
  PILOT_REFERENCE_EDGE_MATERIALIZATION_V1_VERSION,
  SOURCE_DISCOVERY_EVIDENCE_GLOB,
} from "../lib/claims/edges/claim-reference-edge-pilot-original-materializer";

const LIB = "lib/claims/edges/claim-reference-edge-pilot-original-materializer.ts";
const SCRIPT = "scripts/phase7h-claim-reference-edge-materialization-pilot-original-execute.ts";

function main(): void {
  const root = process.cwd();
  const lib = fs.readFileSync(path.join(root, LIB), "utf8");
  const script = fs.readFileSync(path.join(root, SCRIPT), "utf8");

  const checks = {
    lib_exists: fs.existsSync(path.join(root, LIB)),
    script_exists: fs.existsSync(path.join(root, SCRIPT)),
    approval_token: lib.includes(PILOT_EDGE_APPROVAL_TOKEN),
    schema_migration_token: lib.includes(PILOT_EDGE_SCHEMA_MIGRATION_APPROVAL_TOKEN),
    source_discovery_prereq: lib.includes("loadSourceDiscoveryPrerequisite"),
    source_discovery_glob: lib.includes(SOURCE_DISCOVERY_EVIDENCE_GLOB),
    origin: lib.includes(PILOT_EDGE_MATERIALIZATION_ORIGIN),
    no_trid_invent: lib.includes("not invented"),
    pilot_scope: script.includes("PILOT_CASE_RUN_ID"),
    original_bind: script.includes("bindProductionSupabaseEnv"),
    safe_materialized_gate: script.includes("SAFE_REFERENCE_EDGES_MATERIALIZED"),
    no_submissions_insert: !script.includes('from("claim_submissions").insert'),
    no_hard_delete_cases: !script.includes('from("claim_cases").delete'),
    rollback_sql: script.includes("rollback.sql"),
    version: lib.includes(PILOT_REFERENCE_EDGE_MATERIALIZATION_V1_VERSION),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  console.log(JSON.stringify({ smoke: failures.length === 0 ? "pass" : "fail", failures }));
  if (failures.length > 0) process.exitCode = 1;
}

main();
