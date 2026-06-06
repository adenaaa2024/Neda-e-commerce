/**
 * Apply platform_settings.automation_settings column to staging (local) and original (live).
 * Safe: ADD COLUMN IF NOT EXISTS only — no row overwrites.
 *
 *   npx tsx scripts/apply-platform-automation-settings-column.ts
 *   npx tsx scripts/apply-platform-automation-settings-column.ts --apply
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const MIGRATION = "20260833180000_platform_settings_automation_settings_column.sql";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";

type Target = { name: string; ref: string; url: string };

function targetsFromEnv(): Target[] {
  loadEnvLocalIntoProcess();
  const out: Target[] = [];
  const staging = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || process.env.DIRECT_POSTGRES_URL?.trim() || "";
  const original = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  if (staging) {
    const ref = refFromSupabaseUrl(staging.replace(/@db\.([a-z]{20})\./, "https://$1.supabase.co")) ?? STAGING_REF;
    out.push({ name: "local_staging", ref, url: staging });
  }
  if (original) {
    const ref = refFromSupabaseUrl(original.replace(/@db\.([a-z]{20})\./, "https://$1.supabase.co")) ?? ORIGINAL_REF;
    out.push({ name: "original_live", ref, url: original });
  }
  return out;
}

async function columnExists(client: pg.Client): Promise<boolean> {
  const r = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'platform_settings'
         AND column_name = 'automation_settings'
     ) AS exists`,
  );
  return Boolean(r.rows[0]?.exists);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const sql = readFileSync(join(process.cwd(), "supabase/migrations", MIGRATION), "utf8");
  const targets = targetsFromEnv();
  if (!targets.length) {
    console.error("No STAGING_DIRECT_POSTGRES_URL or ORIGINAL_DIRECT_POSTGRES_URL in .env.local");
    process.exit(1);
  }

  const report: Record<string, { before: boolean; after: boolean; applied: boolean }> = {};

  for (const t of targets) {
    const client = new pg.Client({ connectionString: t.url, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      const before = await columnExists(client);
      let applied = false;
      if (apply && !before) {
        await client.query(sql);
        applied = true;
      } else if (apply && before) {
        await client.query(sql);
        applied = true;
      }
      const after = apply ? await columnExists(client) : before;
      report[`${t.name}:${t.ref}`] = { before, after: apply ? after : before, applied: apply && applied };
      console.log(JSON.stringify({ target: t.name, ref: t.ref, before, after: apply ? after : before, applied: apply }));
    } finally {
      await client.end();
    }
  }

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to execute migration.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
