/**
 * Smoke — PHASE-CLAIM-MONEY-LANE-SOURCE-DISCOVERY-V1 (static checks)
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { CLAIM_MONEY_LANE_SOURCE_DISCOVERY_V1_VERSION } from "../lib/claims/submission/claim-money-lane-source-discovery-v1";

const LIB = "lib/claims/submission/claim-money-lane-source-discovery-v1.ts";
const SCRIPT = "scripts/phase-claim-money-lane-source-discovery-v1.ts";

function main(): void {
  const root = process.cwd();
  const lib = fs.readFileSync(path.join(root, LIB), "utf8");
  const script = fs.readFileSync(path.join(root, SCRIPT), "utf8");

  const checks = {
    lib_exists: fs.existsSync(path.join(root, LIB)),
    script_exists: fs.existsSync(path.join(root, SCRIPT)),
    no_db_insert: !script.includes(".insert(") && !lib.includes(".insert("),
    no_db_update: !script.includes(".update(") && !lib.includes(".update("),
    no_amazon_submit: !script.includes("createReport") && !script.includes("submitFeed"),
    cogs_lane: lib.includes("cogs_unit") && lib.includes("COGS_MISSING"),
    sale_price_informational: lib.includes("informational only"),
    reimbursement_safe_match: lib.includes("matchReimbursementRows"),
    recovery_qty_times_cogs: lib.includes("recovery_value_preview"),
    version_constant: lib.includes(CLAIM_MONEY_LANE_SOURCE_DISCOVERY_V1_VERSION),
    safe_flags: script.includes("SAFE_TO_PLAN_COGS_IMPORT_OR_SYNC"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  console.log(
    JSON.stringify({
      smoke: failures.length === 0 ? "pass" : "fail",
      version: CLAIM_MONEY_LANE_SOURCE_DISCOVERY_V1_VERSION,
      failures,
    }),
  );
  if (failures.length > 0) process.exitCode = 1;
}

main();
