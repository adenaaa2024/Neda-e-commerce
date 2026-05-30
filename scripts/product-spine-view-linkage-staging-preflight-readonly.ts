/**
 * Read-only preflight for product spine view linkage staging execute.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const VIEWS = ["v_scanned_items_counted", "v_inventory_item_status", "v_inventory_status"] as const;

async function main(): Promise<void> {
  const runId =
    process.argv.find((x) => x.startsWith("--run-id="))?.split("=")[1]?.trim() ??
    new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z").slice(0, 15) + "Z";
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/product-spine-view-linkage-staging-execute",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const client = new pg.Client({
    connectionString: process.env.STAGING_DIRECT_POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const snapshots: Record<string, unknown> = {};
  for (const v of VIEWS) {
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [v],
    );
    const def = await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [`public.${v}`]);
    snapshots[v] = {
      columns: cols.rows.map((r: { column_name: string }) => r.column_name),
      definition: def.rows[0]?.def ?? null,
    };
  }

  const tracking = await client.query(
    `SELECT * FROM v_inventory_item_status WHERE tracking_number = $1 LIMIT 3`,
    ["1552698729"],
  );
  const linkage = await client.query(
    `SELECT
       v.*,
       ep.id AS ep_id_check,
       ep.resolved_product_id AS ep_resolved_check,
       p.product_name AS products_name_check
     FROM v_inventory_item_status v
     LEFT JOIN expected_packages ep ON ep.id = v.expected_package_id
     LEFT JOIN products p ON p.id = v.resolved_product_id
     WHERE v.tracking_number = $1
     LIMIT 3`,
    ["1552698729"],
  ).catch((e: Error) => ({ rows: [], error: e.message }));

  await client.end();

  fs.writeFileSync(path.join(outDir, "before-view-snapshots.json"), JSON.stringify(snapshots, null, 2));
  fs.writeFileSync(
    path.join(outDir, "before-test-rows.json"),
    JSON.stringify({ tracking_rows: tracking.rows, linkage_probe: linkage }, null, 2),
  );
  console.log(JSON.stringify({ run_id: runId, outDir, snapshots_keys: Object.keys(snapshots) }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
