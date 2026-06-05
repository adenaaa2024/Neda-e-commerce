/**
 * Apply removal rebuild statement_timeout migration to original/production only.
 *   npx tsx scripts/apply-removal-rebuild-statement-timeout-original.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";

const MIGRATION = "20260605180000_removal_rebuild_statement_timeout.sql";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations", MIGRATION), "utf8");
  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query(sql);
  const check = await client.query(`
    SELECT p.proname, unnest(p.proconfig) AS cfg
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('rebuild_removal_item_allocations','rebuild_shipment_tree_from_removal_shipments')
  `);
  await client.end();
  console.log(JSON.stringify({ target_ref: PRODUCTION_REF, migration: MIGRATION, applied: true, proconfig: check.rows }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
