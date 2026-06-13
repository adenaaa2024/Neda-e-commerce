/**
 * PHASE-7A-TASK-CENTER-SCHEMA-STAGING-EXECUTE
 *
 *   npx tsx scripts/phase7a-task-center-schema-staging-execute.ts
 *   APPROVED_STAGING_APPLY_V7A=true npx tsx scripts/phase7a-task-center-schema-staging-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const MIGRATION = "supabase/migrations/20260919120000_phase7a_task_center_schema_staging_rls_gated.sql";
const OUT_BASE = ".cursor/audit-reports/phase7a-task-center-schema-staging-apply";

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

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=$1
     ) AS e`,
    [table],
  );
  return r.rows[0]?.e === true;
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

  const client = new pg.Client({
    connectionString: stagingPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '600s'");

  const before = {
    task_items: await tableExists(client, "task_items"),
    task_comments: await tableExists(client, "task_comments"),
    task_watchers: await tableExists(client, "task_watchers"),
    task_activity_log: await tableExists(client, "task_activity_log"),
    groups_group_type: await columnExists(client, "groups", "group_type"),
    groups_parent_group_id: await columnExists(client, "groups", "parent_group_id"),
  };

  if (!apply) {
    await client.end();
    const dry = {
      dry_run: true,
      target_project_ref: STAGING_REF,
      before,
      migration: MIGRATION,
      approvals_required: {
        APPROVED_STAGING_APPLY_V7A: "true",
        APPROVED_TASK_CENTER_SCHEMA_V3: "yes",
      },
    };
    fs.writeFileSync(path.join(outDir, "dry_run.json"), JSON.stringify(dry, null, 2));
    console.log(JSON.stringify(dry, null, 2));
    console.log(
      "\nApply: APPROVED_STAGING_APPLY_V7A=true npx tsx scripts/phase7a-task-center-schema-staging-execute.ts --apply",
    );
    return;
  }

  if (process.env.APPROVED_STAGING_APPLY_V7A?.trim().toLowerCase() !== "true") {
    throw new Error("APPROVED_STAGING_APPLY_V7A=true required for --apply");
  }

  const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
  await client.query(sql);

  const after = {
    task_items: await tableExists(client, "task_items"),
    task_comments: await tableExists(client, "task_comments"),
    task_watchers: await tableExists(client, "task_watchers"),
    task_activity_log: await tableExists(client, "task_activity_log"),
    groups_group_type: await columnExists(client, "groups", "group_type"),
    groups_parent_group_id: await columnExists(client, "groups", "parent_group_id"),
    task_items_count: Number(
      (await client.query(`SELECT COUNT(*)::int c FROM public.task_items`)).rows[0]?.c ?? 0,
    ),
  };

  await client.end();

  const result = {
    applied: true,
    target_project_ref: STAGING_REF,
    migration_file_created: MIGRATION,
    before,
    after,
    tables_created: [
      "task_items",
      "task_comments",
      "task_watchers",
      "task_activity_log",
    ],
    columns_added_to_groups: ["group_type", "parent_group_id"],
    seeded_rows: 0,
  };
  fs.writeFileSync(path.join(outDir, "apply_result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
