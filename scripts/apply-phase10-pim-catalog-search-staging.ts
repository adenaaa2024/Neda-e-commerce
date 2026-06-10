/**
 * Apply Phase 10 PIM catalog search migration on staging.
 *   npx tsx scripts/apply-phase10-pim-catalog-search-staging.ts
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const MIGRATION = "supabase/migrations/20260913120000_phase10_pim_catalog_identifier_first_search.sql";
const VERSION = "20260913120000";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  const sql = readFileSync(MIGRATION, "utf8");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(sql);
  await client.query(
    `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [VERSION, "phase10_pim_catalog_identifier_first_search.sql"],
  );
  await client.end();
  console.log(JSON.stringify({ applied: true, migration: VERSION }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
