/**
 * Smoke — PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-BUILD-V1
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COGS_BUILD_APPROVAL_KEYS,
  detectForbiddenImportHeaders,
  readCogsBuildApprovalStatus,
  verifyFormulaContract,
} from "../lib/products/contracts/product-cogs-source-build-v1";
import { parseCogsImportCsvTextV1 } from "../lib/claims/submission/product-cogs-source-import-v1";
import {
  buildManualCogsDryRunResultV1,
  PILOT_FNSKUS_V1,
} from "../lib/claims/submission/product-cogs-manual-entry-ui-v1";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..");

const migrationPath =
  "supabase/migrations/20260618120000_phase_product_cogs_source_build_v1_product_cost_snapshots.sql";
assert.ok(fs.existsSync(path.join(REPO, migrationPath)), "migration file missing");

const approval = readCogsBuildApprovalStatus();
assert.equal(approval.write_enabled, false, "write must default disabled");
assert.equal(approval.default_mode, "dry_run_preview");

const forbidden = detectForbiddenImportHeaders(["fnsku", "sale_price", "cost"]);
assert.ok(forbidden.includes("sale_price"));

const parsed = parseCogsImportCsvTextV1(
  "FNSKU,cost,currency,effective_date,source\nX004D9AMWV,12.50,USD,2026-06-15,Vendor quote",
);
assert.equal(parsed.rows.length, 1);

const dryRun = buildManualCogsDryRunResultV1(
  {
    fnsku: PILOT_FNSKUS_V1[0]!,
    unitCost: 12.5,
    currency: "USD",
    effectiveDate: "2026-06-15",
    sourceNote: "Vendor quote",
    approvedBy: "operator",
    sourceType: "manual_override",
  },
  { latestSoldPrice: 12.5, cleanQuantityTotal: 2 },
);
assert.equal(dryRun.ok, false, "sale price match without confirm must fail");

assert.ok(verifyFormulaContract());

const ui = fs.readFileSync(
  path.join(REPO, "components/claim-center/reimbursement-tracking/ProductCogsManualEntryView.tsx"),
  "utf8",
);
assert.match(ui, /Apply COGS \(disabled\)/);
assert.match(ui, /COGS Source Panel/);

console.log(
  JSON.stringify({
    smoke: "pass",
    version: "product-cogs-source-build-v1",
    approval_keys: COGS_BUILD_APPROVAL_KEYS,
    SAFE_PRODUCT_COGS_SOURCE_READY: "contract_ok",
  }),
);
