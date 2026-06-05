/**
 * PRODUCTION removal sync through today — original/live only.
 *
 *   npx tsx scripts/production-removal-sync-through-today.ts           # dry-run counts only
 *   APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC=true npx tsx scripts/production-removal-sync-through-today.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { PRODUCTION_REF } from "../lib/production-db-bind";
import {
  runProductionRemovalSync,
  syncWindowThroughToday,
  type ProductionRemovalSyncResult,
} from "../lib/production-removal-sync-run";

const OUT_BASE = ".cursor/audit-reports/production-warehouse-go-live";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const approved = process.env.APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC?.trim().toLowerCase() === "true";
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, `sync-${rid}`);
  fs.mkdirSync(outDir, { recursive: true });

  const window = syncWindowThroughToday(30);

  if (!apply) {
    const { loadEnvLocalIntoProcess: load } = await import("../lib/staging-project-ref");
    load();
    const pg = await import("pg");
    const { productionPostgresUrl, bindProductionSupabaseEnv } = await import("../lib/production-db-bind");
    const { loadSyncCounts, PRODUCTION_ORG_ID } = await import("../lib/production-removal-sync-run");
    bindProductionSupabaseEnv();
    const client = new pg.default.Client({
      connectionString: productionPostgresUrl(),
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    const counts = await loadSyncCounts(client, PRODUCTION_ORG_ID);
    const imports = await client.query(
      `SELECT report_type, status, created_at::text FROM raw_report_uploads
       WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       ORDER BY created_at DESC LIMIT 10`,
      [PRODUCTION_ORG_ID],
    );
    await client.end();
    const dry = {
      dry_run: true,
      target_ref: PRODUCTION_REF,
      sync_date_range: window,
      counts,
      recent_imports: imports.rows,
      exact_apply:
        "APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC=true npx tsx scripts/production-removal-sync-through-today.ts --apply",
    };
    fs.writeFileSync(path.join(outDir, "dry_run.json"), JSON.stringify(dry, null, 2));
    console.log(JSON.stringify(dry, null, 2));
    return;
  }

  if (!approved) throw new Error("APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC=true required for --apply");

  let result: ProductionRemovalSyncResult;
  try {
    result = await runProductionRemovalSync({ window });
  } catch (e) {
    const err = { ok: false, error: e instanceof Error ? e.message : String(e) };
    fs.writeFileSync(path.join(outDir, "sync_error.json"), JSON.stringify(err, null, 2));
    console.log(JSON.stringify(err, null, 2));
    process.exit(1);
  }

  const summary = {
    target_db_confirmed: result.target_ref === PRODUCTION_REF,
    sync_report_types_run: ["REMOVAL_ORDER", "REMOVAL_SHIPMENT"],
    sync_date_range: result.window,
    rows_before_after: {
      removals: [result.counts_before.removals, result.counts_after.removals],
      shipments: [result.counts_before.shipments, result.counts_after.shipments],
      expected_packages_derived: [
        result.counts_before.expected_packages_derived,
        result.counts_after.expected_packages_derived,
      ],
      return_items: [result.counts_before.return_items, result.counts_after.return_items],
      packages: [result.counts_before.packages, result.counts_after.packages],
    },
    expected_packages_updated: result.rebuild,
    latest_shipment_date: result.latest_shipment_date,
    failed_imports: result.errors,
    product_linkage_result: {
      products_unchanged: result.products_unchanged,
      pim_unchanged: result.pim_unchanged,
    },
    rebuild_valid: result.rebuild_valid,
    order_fetch: result.order_fetch,
    shipment_fetch: result.shipment_fetch,
  };

  fs.writeFileSync(path.join(outDir, "sync_result.json"), JSON.stringify({ ...summary, full: result }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (result.errors.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
