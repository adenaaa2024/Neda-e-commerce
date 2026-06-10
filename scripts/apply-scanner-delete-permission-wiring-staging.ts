/** Apply scanner delete permission migration to staging (operator use only). */
import { readFileSync } from "node:fs";
import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url?.includes("eiqfaapyumhixxoeltgu")) throw new Error("STAGING_DIRECT_POSTGRES_URL guard failed");
  const sql = readFileSync(
    "supabase/migrations/20260912120000_scanner_delete_unit_permission_wiring.sql",
    "utf8",
  );
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(sql);
  await client.end();
  console.log("migration applied to staging");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
