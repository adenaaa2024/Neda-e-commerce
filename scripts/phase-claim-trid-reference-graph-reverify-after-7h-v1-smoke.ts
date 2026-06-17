/**
 * Smoke — PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AFTER-7H-V1 (static checks only)
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  TRID_REFERENCE_GRAPH_REVERIFY_AFTER_7H_V1_VERSION,
} from "../lib/claims/reference/claim-trid-reference-graph-reverify-after-7h-v1";

const REVVERIFY_MODULE = "lib/claims/reference/claim-trid-reference-graph-reverify-after-7h-v1.ts";
const REVVERIFY_SCRIPT = "scripts/phase-claim-trid-reference-graph-reverify-after-7h-v1.ts";

function fail(msg: string): never {
  throw new Error(`SMOKE_FAIL: ${msg}`);
}

function main(): void {
  const root = process.cwd();
  if (!fs.existsSync(path.join(root, REVVERIFY_MODULE))) {
    fail(`missing ${REVVERIFY_MODULE}`);
  }
  if (!fs.existsSync(path.join(root, REVVERIFY_SCRIPT))) {
    fail(`missing ${REVVERIFY_SCRIPT}`);
  }

  const mod = fs.readFileSync(path.join(root, REVVERIFY_MODULE), "utf8");
  const script = fs.readFileSync(path.join(root, REVVERIFY_SCRIPT), "utf8");

  if (!mod.includes(TRID_REFERENCE_GRAPH_REVERIFY_AFTER_7H_V1_VERSION)) {
    fail("reverify module missing version constant");
  }
  if (!mod.includes("missing_materialized_reference_edges")) {
    fail("reverify module must block missing_materialized_reference_edges");
  }
  if (!mod.includes("export_stale_needs_regeneration")) {
    fail("reverify module must flag export_stale_needs_regeneration");
  }
  if (!mod.includes("buildHandoffReferenceGraph")) {
    fail("reverify module must verify handoff reference graph");
  }
  if (!script.includes("bindProductionSupabaseEnv")) {
    fail("reverify script must bind production env");
  }
  if (!script.includes("claim_reference_edges")) {
    fail("reverify script must count claim_reference_edges for no-write guard");
  }
  if (!script.includes("SAFE_TO_REGENERATE_PDF_EXPORT_WITH_REFERENCES")) {
    fail("reverify script must emit SAFE_TO_REGENERATE_PDF_EXPORT_WITH_REFERENCES");
  }
  if (!script.includes("SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY")) {
    fail("reverify script must emit SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY");
  }
  if (script.includes(".insert(") || script.includes(".update(") || script.includes(".delete(")) {
    fail("reverify script must not mutate DB");
  }

  console.log(
    JSON.stringify({ smoke: "pass", version: TRID_REFERENCE_GRAPH_REVERIFY_AFTER_7H_V1_VERSION }),
  );
}

main();
