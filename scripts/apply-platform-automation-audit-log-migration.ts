import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const MIGRATION = "20260833200000_platform_automation_audit_log.sql";

async function apply(url: string | undefined, label: string): Promise<void> {
  if (!url?.trim()) {
    console.log(JSON.stringify({ label, skipped: true }));
    return;
  }
  const sql = readFileSync(join(process.cwd(), "supabase/migrations", MIGRATION), "utf8");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(sql);
  const check = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='platform_automation_audit_log'
     ) AS ok`,
  );
  await client.end();
  console.log(JSON.stringify({ label, applied: true, table_exists: check.rows[0]?.ok }));
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  await apply(process.env.STAGING_DIRECT_POSTGRES_URL, "staging");
  await apply(process.env.ORIGINAL_DIRECT_POSTGRES_URL, "original");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
