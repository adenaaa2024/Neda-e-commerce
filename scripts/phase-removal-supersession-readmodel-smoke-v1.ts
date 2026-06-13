/**
 * Smoke: removal source supersession read-model (pure + connector SELECT).
 *   npx tsx scripts/phase-removal-supersession-readmodel-smoke-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  classifyRemovalDetailRowsInScope,
  filterExpectedPackagesWithRemovalSupersession,
  resolveRemovalScopeTruth,
  REMOVAL_SOURCE_SUPERSESSION_RULES,
} from "../lib/claims/removal/removal-source-supersession-readmodel";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT = ".cursor/audit-reports/phase-removal-supersession-readmodel-smoke-v1";

async function main(): Promise<void> {
  const unit = run387003587UnitSmoke();

  loadEnvLocalIntoProcess();
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  require.cache[require.resolve("server-only")] = {
    id: "server-only",
    filename: "server-only",
    loaded: true,
    exports: {},
  } as NodeModule;

  const { supabaseServer } = await import("../lib/supabase-server");
  const { buildSourceConnectorReadiness } = await import("../lib/claims/connectors/source-connector-readmodel");
  const payload = await buildSourceConnectorReadiness(supabaseServer, ORG, STORE);

  const rid = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const result = {
    unit_smoke: unit,
    connector_has_supersession: payload.removal_source_supersession != null,
    supersession_detail_count:
      "detail_row_count" in payload.removal_source_supersession
        ? payload.removal_source_supersession.detail_row_count
        : null,
    affected_row_count:
      "affected_row_count" in payload.removal_source_supersession
        ? payload.removal_source_supersession.affected_row_count
        : null,
    smoke: unit.pass && payload.removal_source_supersession != null ? "PASS" : "FAIL",
  };

  fs.writeFileSync(path.join(outDir, "smoke.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (result.smoke !== "PASS") process.exit(1);
}

function run387003587UnitSmoke(): { pass: boolean; checks: Record<string, unknown> } {
  const olderPartial = {
    id: "older-partial",
    organization_id: ORG,
    store_id: STORE,
    order_id: "IxaWHWlopw",
    sku: "B01C7G00TA-VEN",
    fnsku: "X004LKS4VD",
    disposition: "Sellable",
    order_type: "Return",
    shipped_quantity: 1,
    in_process_quantity: 52,
    tracking_number: "387003587",
    upload_created_at: "2026-05-28T00:00:00.000Z",
  };
  const newerFull = {
    id: "newer-full",
    organization_id: ORG,
    store_id: STORE,
    order_id: "IxaWHWlopw",
    sku: "B01C7G00TA-VEN",
    fnsku: "X004LKS4VD",
    disposition: "Sellable",
    order_type: "Return",
    shipped_quantity: 53,
    in_process_quantity: 0,
    tracking_number: "387003587",
    upload_created_at: "2026-06-01T00:00:00.000Z",
  };
  const shipment = {
    id: "ship-1",
    order_id: "IxaWHWlopw",
    sku: "B01C7G00TA-VEN",
    fnsku: "X004LKS4VD",
    disposition: "Sellable",
    tracking_number: "387003587",
    shipped_quantity: 52,
  };

  const classified = classifyRemovalDetailRowsInScope([olderPartial, newerFull]);
  const truth = resolveRemovalScopeTruth([olderPartial, newerFull], [shipment], {
    tracking_number: "387003587",
  });
  const epFilter = filterExpectedPackagesWithRemovalSupersession([
    { id: "ep-matched", build_status: "matched", expected_scan_quantity: 52 },
    { id: "ep-overflow", build_status: "shipment_overflow_conflict", expected_scan_quantity: 1 },
  ]);

  const olderCls = classified.find((r) => r.id === "older-partial");
  const newerCls = classified.find((r) => r.id === "newer-full");

  const checks = {
    rules_version: REMOVAL_SOURCE_SUPERSESSION_RULES.version,
    older_is_superseded: olderCls?.supersession_class === "superseded_stale_partial",
    newer_is_current: newerCls?.supersession_class === "current",
    source_mismatch: truth.source_mismatch,
    clean_quantity: truth.clean_quantity,
    clean_is_52: truth.clean_quantity === 52,
    claim_auto_pick_null: truth.claim_quantity_auto_pick === null,
    claim_ready_qty_sum: epFilter.claim_ready_qty_sum,
    claim_ready_excludes_overflow: epFilter.review_needed_count === 1,
  };

  const pass =
    checks.older_is_superseded === true &&
    checks.newer_is_current === true &&
    checks.clean_is_52 === true &&
    checks.claim_ready_qty_sum === 52 &&
    checks.claim_ready_excludes_overflow === true;

  return { pass, checks };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
