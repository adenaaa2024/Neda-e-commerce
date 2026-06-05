/**
 * PRODUCTION_WAREHOUSE_GO_LIVE — read-only readiness audit (original/live only).
 *   npx tsx scripts/production-warehouse-go-live-readiness-audit.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { PRODUCTION_REF, productionPostgresUrl } from "../lib/production-db-bind";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/production-warehouse-go-live";

const V2_RPCS = [
  "allocate_expected_items_for_return_item_ids",
  "delete_package_cascade",
  "delete_pallet_cascade",
  "delete_return_item_with_expected_release",
  "move_return_item_parent",
  "release_expected_item_unit",
] as const;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function fnExists(c: pg.Client, name: string): Promise<boolean> {
  const r = await c.query(
    `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=$1`,
    [name],
  );
  return Number(r.rows[0]?.n) > 0;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  const warnings: string[] = [];

  let targetConfirmed = false;
  try {
    productionPostgresUrl();
    targetConfirmed = true;
  } catch (e) {
    blockers.push(e instanceof Error ? e.message : String(e));
  }

  if (!targetConfirmed) {
    const report = { target_db_confirmed: false, blockers, production_readiness_status: "BLOCKED" };
    fs.writeFileSync(path.join(outDir, "readiness.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const rpcCheck: Record<string, boolean> = {};
  for (const fn of V2_RPCS) {
    rpcCheck[fn] = await fnExists(client, fn);
    if (!rpcCheck[fn]) blockers.push(`missing_rpc:${fn}`);
  }

  const tables = await client.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public'
     AND tablename IN ('audit_events','undo_snapshots','expected_packages','return_items','packages','pallets')`,
  );
  const have = new Set(tables.rows.map((r) => (r as { tablename: string }).tablename));
  for (const t of ["audit_events", "undo_snapshots"]) {
    if (!have.has(t)) warnings.push(`table_missing:${t} (undo v2 — defer if not using delete/undo yet)`);
  }

  const cols = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name IN ('return_items','packages','pallets')
       AND column_name IN ('deleted_by','undo_batch_id')`,
  );
  const colSet = new Set(cols.rows.map((r) => `${(r as { table_name: string }).table_name}.${(r as { column_name: string }).column_name}`));
  for (const t of ["return_items", "packages", "pallets"]) {
    for (const c of ["deleted_by", "undo_batch_id"]) {
      if (!colSet.has(`${t}.${c}`)) warnings.push(`column_missing:${t}.${c}`);
    }
  }

  const imports = await client.query(
    `SELECT report_type, status, created_at::text
     FROM raw_report_uploads WHERE organization_id=$1::uuid
     ORDER BY created_at DESC LIMIT 15`,
    [ORG_ID],
  );
  const failedTop = imports.rows.find((r) => /fail|error/i.test(String((r as { status: string }).status)));
  if (failedTop && imports.rows.indexOf(failedTop) === 0) {
    warnings.push("stale_failed_import_at_top — health card uses pickHealthImportRow skip");
  }

  const counts = await client.query(
    `SELECT
       (SELECT count(*)::bigint FROM return_items WHERE organization_id=$1 AND deleted_at IS NULL) ri,
       (SELECT count(*)::bigint FROM packages WHERE organization_id=$1 AND deleted_at IS NULL) pkg,
       (SELECT count(*)::bigint FROM expected_packages WHERE organization_id=$1) ep,
       (SELECT count(*)::bigint FROM amazon_removal_shipments WHERE organization_id=$1) ships,
       (SELECT max(shipment_date)::text FROM amazon_removal_shipments WHERE organization_id=$1) latest_ship,
       (SELECT count(*)::bigint FROM expected_packages WHERE organization_id=$1
          AND build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NULL) ep_unresolved`,
    [ORG_ID],
  );
  const c = counts.rows[0] as Record<string, string>;

  const spApiFlags = {
    worker: process.env.ENABLE_AMAZON_REPORTS_API_WORKER === "true",
    removal_order: process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER === "true",
    removal_shipment: process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT === "true",
    lwa_configured: Boolean(process.env.AMAZON_LWA_CLIENT_ID?.trim()),
  };
  if (!spApiFlags.lwa_configured) warnings.push("AMAZON_LWA_CLIENT_ID not in local env — verify Vercel production env");

  const report = {
    run_id: rid,
    out_dir: outDir,
    target_db_confirmed: true,
    target_ref: PRODUCTION_REF,
    production_readiness_status: blockers.length ? "BLOCKED" : warnings.length ? "READY_WITH_WARNINGS" : "READY",
    blockers_found: blockers,
    warnings,
    scanner_backend: rpcCheck,
    operational_counts: c,
    recent_imports: imports.rows,
    sp_api_env_local: spApiFlags,
    pwa_notes: {
      orientation_lock: "portrait-primary runtime lock — operator-mobile scanner devices only (Zebra/Android/iPhone PWA); not manifest-global, not desktop",
      browser_usable: "desktop/laptop browsers ignore orientation lock; normal ERP layout",
    },
    SAFE_FOR_WAREHOUSE_GO_LIVE_TOMORROW: blockers.length === 0 ? "yes_with_sync" : "no",
  };

  fs.writeFileSync(path.join(outDir, "readiness.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "01_readiness.md"),
    `# Production warehouse readiness\n\n- Target: \`${PRODUCTION_REF}\`\n- Status: **${report.production_readiness_status}**\n\n## Blockers\n${blockers.map((b) => `- ${b}`).join("\n") || "- none"}\n\n## Warnings\n${warnings.map((w) => `- ${w}`).join("\n") || "- none"}\n`,
  );

  await client.end();
  console.log(JSON.stringify(report, null, 2));
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
