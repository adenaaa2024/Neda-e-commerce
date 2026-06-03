/**
 * ORIGINAL-DEMO-SCHEMA-PARITY-APPLY — apply 01/02/03/05 on original only.
 *
 *   npx tsx scripts/original-demo-schema-parity-apply.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const RUN_ID = "20260603T221500Z";
const PACK_DIR = path.join(
  process.cwd(),
  ".cursor/audit-reports/original-demo-schema-parity",
  RUN_ID,
);

const APPLY_FILES = [
  "01_backup_original_schema_refs.sql",
  "02_apply_required_additive_schema.sql",
  "03_apply_required_config.sql",
] as const;

const VERIFY_FILE = "05_verify_demo_readiness.sql";

function refFromPgUrl(url: string): string | null {
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? refFromSupabaseUrl(url);
}

async function runSqlFile(client: pg.Client, filePath: string): Promise<void> {
  const sql = fs.readFileSync(filePath, "utf8");
  await client.query(sql);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();

  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalRef = refFromPgUrl(originalUrl);
  const stagingRef = refFromPgUrl(stagingUrl);

  const blockers: string[] = [];
  if (!originalUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL missing");
  if (originalRef !== ORIGINAL_REF) blockers.push(`original ref mismatch: ${originalRef}`);
  if (stagingRef !== STAGING_REF) blockers.push(`staging ref mismatch: ${stagingRef}`);
  for (const f of [...APPLY_FILES, VERIFY_FILE]) {
    if (!fs.existsSync(path.join(PACK_DIR, f))) blockers.push(`missing pack file: ${f}`);
  }

  if (blockers.length) {
    console.log(JSON.stringify({ ok: false, apply, blockers }));
    process.exit(1);
  }

  if (!apply) {
    console.log(
      JSON.stringify({
        ok: true,
        dry_run: true,
        pack_dir: PACK_DIR,
        would_apply: APPLY_FILES,
        would_verify: VERIFY_FILE,
        skipped: ["04_apply_recommended_indexes.sql"],
        original_ref: originalRef,
        staging_ref: stagingRef,
      }),
    );
    return;
  }

  const client = new pg.Client({ connectionString: originalUrl });
  await client.connect();

  const applied: string[] = [];
  try {
    for (const f of APPLY_FILES) {
      await runSqlFile(client, path.join(PACK_DIR, f));
      applied.push(f);
    }

    const verifySql = fs.readFileSync(path.join(PACK_DIR, VERIFY_FILE), "utf8");
    const verifyRes = await client.query(verifySql);

    const manifest = {
      ok: true,
      run_id: RUN_ID,
      original_ref: originalRef,
      staging_ref: stagingRef,
      applied,
      skipped: ["04_apply_recommended_indexes.sql"],
      verify_row_count: verifyRes.length,
      verify_samples: verifyRes.slice(0, 12).map((r) => r.rows),
    };

    fs.writeFileSync(path.join(PACK_DIR, "apply_result.json"), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(JSON.stringify({ ok: false, applied, error: msg }));
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
