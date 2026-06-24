/**
 * PHASE-7A-TASK-CENTER-STAGING-VERIFY-AND-ADDITIVE-RECONCILE — read-only staging verify.
 *
 * Read-only inspection of the staging Task Center schema prior to drafting an
 * additive reconciliation migration (Option A). Performs NO writes (no INSERT,
 * no DDL) and does NOT run a build. Staging-only guard enforced.
 *
 *   npx tsx scripts/phase7a-task-center-additive-reconcile-verify.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/phase7a-task-center-additive-reconcile-verify";
const TASK_TABLES = ["task_items", "task_comments", "task_watchers", "task_activity_log"] as const;

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

async function tableColumns(client: pg.Client, table: string) {
  const r = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1
     ORDER BY ordinal_position`,
    [table],
  );
  return r.rows;
}

async function tableIndexes(client: pg.Client, table: string): Promise<string[]> {
  const r = await client.query(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname='public' AND tablename=$1
     ORDER BY indexname`,
    [table],
  );
  return r.rows.map((x) => String(x.indexname));
}

async function tableChecks(client: pg.Client, table: string) {
  const r = await client.query(
    `SELECT con.conname, pg_get_constraintdef(con.oid) AS def
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname=$1 AND con.contype='c'
     ORDER BY con.conname`,
    [table],
  );
  return r.rows;
}

async function rlsState(client: pg.Client, table: string) {
  const enabled = await client.query(
    `SELECT c.relrowsecurity AS rls_enabled
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname=$1`,
    [table],
  );
  const policies = await client.query(
    `SELECT p.polname,
            CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                          WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                          WHEN '*' THEN 'ALL' ELSE p.polcmd::text END AS cmd,
            p.polroles::regrole[] AS roles,
            pg_get_expr(p.polqual, p.polrelid) AS using_expr,
            pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
     FROM pg_policy p
     JOIN pg_class c ON c.oid=p.polrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname=$1
     ORDER BY p.polname`,
    [table],
  );
  return {
    rls_enabled: enabled.rows[0]?.rls_enabled === true,
    policies: policies.rows.map((p) => ({
      name: String(p.polname),
      cmd: String(p.cmd),
      roles: String(p.roles),
      using: p.using_expr ? String(p.using_expr) : null,
      with_check: p.with_check_expr ? String(p.with_check_expr) : null,
    })),
  };
}

async function main(): Promise<void> {
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

  const exists: Record<string, boolean> = {};
  for (const t of TASK_TABLES) exists[t] = await tableExists(client, t);

  const taskItemsColumns = exists.task_items ? await tableColumns(client, "task_items") : [];
  const taskCommentsColumns = exists.task_comments ? await tableColumns(client, "task_comments") : [];
  const taskActivityColumns = exists.task_activity_log
    ? await tableColumns(client, "task_activity_log")
    : [];
  const taskWatchersColumns = exists.task_watchers ? await tableColumns(client, "task_watchers") : [];

  const groupsColumns = await tableColumns(client, "groups");
  const groupHas = {
    group_type: groupsColumns.some((c) => c.column_name === "group_type"),
    parent_group_id: groupsColumns.some((c) => c.column_name === "parent_group_id"),
  };

  const taskItemsIndexes = exists.task_items ? await tableIndexes(client, "task_items") : [];
  const taskItemsChecks = exists.task_items ? await tableChecks(client, "task_items") : [];

  // Reconcile-target columns: do they already exist?
  const reconcileTargets = ["module_link_type", "module_context", "ai_summary"] as const;
  const reconcileColumnPresent: Record<string, boolean> = {};
  for (const c of reconcileTargets) {
    reconcileColumnPresent[c] = taskItemsColumns.some((col) => col.column_name === c);
  }

  const rls: Record<string, unknown> = {};
  for (const t of TASK_TABLES) {
    rls[t] = exists[t] ? await rlsState(client, t) : { rls_enabled: false, policies: [] };
  }

  const rowCount = exists.task_items
    ? Number((await client.query(`SELECT COUNT(*)::int c FROM public.task_items`)).rows[0]?.c ?? 0)
    : 0;

  // Read-only backfill probe: how many rows would the optional backfill touch?
  let claimsBackfillProbe: Record<string, number> = {};
  if (exists.task_items) {
    const probe = await client.query(
      `SELECT source_entity_type, COUNT(*)::int c
       FROM public.task_items
       WHERE source_module='claims' AND deleted_at IS NULL
       GROUP BY source_entity_type`,
    );
    for (const row of probe.rows) {
      claimsBackfillProbe[String(row.source_entity_type ?? "null")] = Number(row.c);
    }
  }

  await client.end();

  const allTablesExist = TASK_TABLES.every((t) => exists[t]);

  const summary = {
    target_project_ref: STAGING_REF,
    read_only: true,
    writes_performed: 0,
    task_tables_exist_on_staging: allTablesExist,
    table_existence: exists,
    task_items_row_count: rowCount,
    groups_has_group_type: groupHas.group_type,
    groups_has_parent_group_id: groupHas.parent_group_id,
    reconcile_columns_already_present: reconcileColumnPresent,
    task_items_columns: taskItemsColumns,
    task_comments_columns: taskCommentsColumns,
    task_watchers_columns: taskWatchersColumns,
    task_activity_log_columns: taskActivityColumns,
    groups_columns: groupsColumns,
    task_items_indexes: taskItemsIndexes,
    task_items_check_constraints: taskItemsChecks,
    rls,
    claims_backfill_probe_by_source_entity_type: claimsBackfillProbe,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n[out] ${path.relative(process.cwd(), outDir)}/results.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
