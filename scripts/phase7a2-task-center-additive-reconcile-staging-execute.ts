/**
 * PHASE-7A2-TASK-CENTER-ADDITIVE-RECONCILE-STAGING-EXECUTE
 *
 * Applies the additive reconcile migration (module_link_type / module_context /
 * ai_summary on public.task_items) to STAGING ONLY. Mirrors the approval-gated
 * pattern of scripts/phase7a-task-center-schema-staging-execute.ts.
 *
 * Strictly additive. No data seed. No UI change. No other migration executed.
 *
 *   npx tsx scripts/phase7a2-task-center-additive-reconcile-staging-execute.ts            # dry-run
 *   APPROVED_STAGING_APPLY_V7A2=true npx tsx scripts/phase7a2-task-center-additive-reconcile-staging-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const MIGRATION =
  "supabase/migrations/20260920120000_phase7a2_task_center_additive_module_link_context_ai_summary.sql";
const OUT_BASE = ".cursor/audit-reports/phase7a2-task-center-additive-reconcile-staging-apply";
const NEW_COLUMNS = ["module_link_type", "module_context", "ai_summary"] as const;
const NEW_INDEX = "task_items_organization_module_link_type_idx";
const NEW_CHECK = "task_items_module_link_type_check";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function assertStagingOnly(url: string): void {
  if (!url.includes(STAGING_REF)) {
    throw new Error(`BLOCKED: postgres URL must target staging ${STAGING_REF}`);
  }
  if (url.includes(ORIGINAL_REF)) {
    throw new Error(`BLOCKED: original/live project ref ${ORIGINAL_REF} detected`);
  }
}

function stagingPostgresUrl(): string {
  const url =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  assertStagingOnly(url);
  return url;
}

async function columnExists(client: pg.Client, table: string, col: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS e`,
    [table, col],
  );
  return r.rows[0]?.e === true;
}

async function indexExists(client: pg.Client, indexName: string): Promise<boolean> {
  const r = await client.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${indexName}`]);
  return r.rows[0]?.e === true;
}

async function constraintExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname='task_items' AND con.conname=$1
     ) AS e`,
    [name],
  );
  return r.rows[0]?.e === true;
}

async function snapshot(client: pg.Client) {
  const cols: Record<string, boolean> = {};
  for (const c of NEW_COLUMNS) cols[c] = await columnExists(client, "task_items", c);
  return {
    columns: cols,
    index: await indexExists(client, NEW_INDEX),
    check: await constraintExists(client, NEW_CHECK),
    task_items_count: Number(
      (await client.query(`SELECT COUNT(*)::int c FROM public.task_items`)).rows[0]?.c ?? 0,
    ),
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const targetRef = getStagingProjectRef();
  if (targetRef !== STAGING_REF) {
    throw new Error(`BLOCKED: STAGING_PROJECT_REF must be ${STAGING_REF}, got ${targetRef}`);
  }

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const migrationPath = path.join(process.cwd(), MIGRATION);
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`BLOCKED: migration file not found: ${MIGRATION}`);
  }

  const client = new pg.Client({
    connectionString: stagingPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '600s'");

  const before = await snapshot(client);

  console.log(`[target] staging project ref: ${STAGING_REF}`);
  console.log(`[migration] ${MIGRATION}`);
  console.log(`[before] ${JSON.stringify(before)}`);

  if (!apply) {
    await client.end();
    const dry = {
      dry_run: true,
      target_project_ref: STAGING_REF,
      migration: MIGRATION,
      before,
      approvals_required: { APPROVED_STAGING_APPLY_V7A2: "true" },
    };
    fs.writeFileSync(path.join(outDir, "dry_run.json"), JSON.stringify(dry, null, 2));
    console.log(JSON.stringify(dry, null, 2));
    console.log(
      "\nApply: APPROVED_STAGING_APPLY_V7A2=true npx tsx scripts/phase7a2-task-center-additive-reconcile-staging-execute.ts --apply",
    );
    return;
  }

  if (process.env.APPROVED_STAGING_APPLY_V7A2?.trim().toLowerCase() !== "true") {
    await client.end();
    throw new Error("APPROVED_STAGING_APPLY_V7A2=true required for --apply");
  }

  const sql = fs.readFileSync(migrationPath, "utf8");
  await client.query(sql);

  const after = await snapshot(client);

  await client.end();

  const allColumns = NEW_COLUMNS.every((c) => after.columns[c]);
  const ok = allColumns && after.index && after.check;

  const result = {
    applied: true,
    target_project_ref: STAGING_REF,
    migration_file_executed: MIGRATION,
    before,
    after,
    columns_confirmed: allColumns,
    index_confirmed: after.index,
    check_constraint_confirmed: after.check,
    seeded_rows: 0,
    apply_result: ok ? "PASS" : "FAIL",
    production_touched: "no",
  };
  fs.writeFileSync(path.join(outDir, "apply_result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n[out] ${path.relative(process.cwd(), outDir)}/apply_result.json`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
