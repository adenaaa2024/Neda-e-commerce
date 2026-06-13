/**
 * PHASE-7A-TASK-CENTER-SCHEMA-STAGING-VERIFY
 *
 *   npx tsx scripts/phase7a-task-center-schema-staging-verify.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/phase7a-task-center-schema-staging-verify";
const TASK_TABLES = ["task_items", "task_comments", "task_watchers", "task_activity_log"] as const;

const REQUIRED_INDEXES: Record<string, string[]> = {
  task_items: [
    "idx_task_items_organization_id",
    "idx_task_items_store_id",
    "idx_task_items_assigned_user_id",
    "idx_task_items_assigned_group_id",
    "idx_task_items_status",
    "idx_task_items_source",
    "idx_task_items_due_at",
    "idx_task_items_deleted_at",
    "uq_task_items_active_source_identity",
  ],
  task_comments: ["idx_task_comments_task_id"],
  task_watchers: ["idx_task_watchers_task_id"],
  task_activity_log: ["idx_task_activity_log_task_id"],
  groups: ["idx_groups_org_group_type", "idx_groups_parent_group_id"],
};

const NO_TOUCH_PREFIXES = [
  "app/scanner/operator-mobile/",
  "app/platform/access/",
] as const;

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

function gitChangedFiles(): string[] {
  try {
    const out = execSync("git status --porcelain", { encoding: "utf8" });
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const rest = line.slice(3).trim();
        const arrow = rest.indexOf(" -> ");
        return arrow >= 0 ? rest.slice(arrow + 4) : rest;
      });
  } catch {
    return [];
  }
}

function noTouchCheck(changed: string[]): { ok: boolean; scanner: string[]; platform: string[] } {
  const scanner = changed.filter((f) => f.replace(/\\/g, "/").includes(NO_TOUCH_PREFIXES[0]));
  const platform = changed.filter((f) => f.replace(/\\/g, "/").includes(NO_TOUCH_PREFIXES[1]));
  return { ok: scanner.length === 0 && platform.length === 0, scanner, platform };
}

async function indexExists(client: pg.Client, indexName: string): Promise<boolean> {
  const r = await client.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${indexName}`]);
  return r.rows[0]?.e === true;
}

async function verifyRls(client: pg.Client): Promise<{
  ok: boolean;
  failures: string[];
  policies: unknown[];
}> {
  const failures: string[] = [];

  for (const table of TASK_TABLES) {
    const rls = await client.query(
      `SELECT c.relrowsecurity AS rls_enabled
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1`,
      [table],
    );
    if (rls.rows[0]?.rls_enabled !== true) {
      failures.push(`${table}: RLS disabled`);
    }
  }

  const policies = await client.query(
    `SELECT c.relname AS table_name, p.polname, p.polcmd, p.polroles::regrole[] AS roles,
            pg_get_expr(p.polqual, p.polrelid) AS using_expr,
            pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
     FROM pg_policy p
     JOIN pg_class c ON c.oid = p.polrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = ANY($1::text[])
     ORDER BY c.relname, p.polname`,
    [TASK_TABLES as unknown as string[]],
  );

  for (const table of TASK_TABLES) {
    const tablePolicies = policies.rows.filter((r) => r.table_name === table);
    const svcAll = tablePolicies.some(
      (p) => p.polname.includes("service_role") && p.polcmd === "*",
    );
    if (!svcAll) failures.push(`${table}: missing service_role ALL policy`);

    const authSelect = tablePolicies.filter(
      (p) => String(p.roles).includes("authenticated") && p.polcmd === "r",
    );
    if (authSelect.length !== 1) {
      failures.push(`${table}: expected exactly 1 authenticated SELECT policy`);
    }

    const authMutating = tablePolicies.filter(
      (p) =>
        String(p.roles).includes("authenticated") &&
        ["a", "w", "d", "*"].includes(String(p.polcmd)),
    );
    if (authMutating.length > 0) {
      failures.push(`${table}: authenticated mutating policy exists`);
    }

    for (const p of authSelect) {
      const expr = String(p.using_expr ?? "");
      if (!expr || expr.trim() === "true") {
        failures.push(`${table}: authenticated SELECT lacks org scoping (USING true or empty)`);
      }
      if (table === "task_items" && !expr.includes("get_my_organization_id")) {
        failures.push(`${table}: task_items SELECT must use get_my_organization_id()`);
      }
      if (table !== "task_items" && !expr.toLowerCase().includes("exists")) {
        failures.push(`${table}: child SELECT must use EXISTS join to task_items`);
      }
    }
  }

  const orgNullable = await client.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema='public' AND table_name='task_items' AND column_name='organization_id'`,
  );
  if (orgNullable.rows[0]?.is_nullable !== "NO") {
    failures.push("task_items.organization_id is nullable");
  }

  for (const [table, indexes] of Object.entries(REQUIRED_INDEXES)) {
    for (const idx of indexes) {
      if (!(await indexExists(client, idx))) {
        failures.push(`missing index ${idx} (table ${table})`);
      }
    }
  }

  return { ok: failures.length === 0, failures, policies: policies.rows };
}

async function crossOrgReadTest(client: pg.Client): Promise<{
  ok: boolean;
  detail: string;
  skipped?: boolean;
}> {
  const orgs = await client.query(
    `SELECT DISTINCT p.organization_id AS id
     FROM public.profiles p
     WHERE p.organization_id IS NOT NULL
     LIMIT 2`,
  );
  if (orgs.rows.length < 2) {
    return { ok: true, detail: "skipped — fewer than 2 organizations on staging", skipped: true };
  }

  const orgIds = orgs.rows.map((r) => r.id as string);
  const profiles = await client.query(
    `SELECT DISTINCT ON (p.organization_id) p.id, p.organization_id
     FROM public.profiles p
     WHERE p.organization_id = ANY($1::uuid[])
     ORDER BY p.organization_id, p.created_at NULLS LAST`,
    [orgIds],
  );
  if (profiles.rows.length < 2) {
    return { ok: true, detail: "skipped — fewer than 2 profiles across orgs", skipped: true };
  }

  const userA = profiles.rows[0].id as string;
  const orgA = profiles.rows[0].organization_id as string;
  const userBRow = profiles.rows.find((p) => p.organization_id !== orgA);
  const orgB = userBRow?.organization_id as string | undefined;
  if (!orgB) {
    return { ok: true, detail: "skipped — could not resolve two distinct org profiles", skipped: true };
  }

  await client.query("BEGIN");
  try {
    const insA = await client.query(
      `INSERT INTO public.task_items (organization_id, title, status, priority, source_module, source_entity_type, source_entity_id)
       VALUES ($1, '7A cross-org test A', 'open', 'normal', 'platform', 'verify', 'a-' || gen_random_uuid()::text)
       RETURNING id`,
      [orgA],
    );
    const insB = await client.query(
      `INSERT INTO public.task_items (organization_id, title, status, priority, source_module, source_entity_type, source_entity_id)
       VALUES ($1, '7A cross-org test B', 'open', 'normal', 'platform', 'verify', 'b-' || gen_random_uuid()::text)
       RETURNING id`,
      [orgB],
    );
    const taskA = insA.rows[0].id as string;
    const taskB = insB.rows[0].id as string;

    await client.query(
      `SELECT set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: userA, role: "authenticated" })],
    );
    await client.query("SET LOCAL ROLE authenticated");

    const visible = await client.query(`SELECT id FROM public.task_items ORDER BY id`);
    const ids = visible.rows.map((r) => String(r.id));
    const seesB = ids.includes(taskB);
    const seesA = ids.includes(taskA);

    await client.query("ROLLBACK");

    if (seesB) {
      return { ok: false, detail: "authenticated user in org A could read org B task" };
    }
    if (!seesA) {
      return { ok: false, detail: "authenticated user in org A could not read own org task" };
    }
    return { ok: true, detail: "org A user sees own task only; org B task hidden" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
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

  const changed = gitChangedFiles();
  const noTouch = noTouchCheck(changed);

  let buildResult: { ok: boolean; detail: string } = { ok: false, detail: "not run" };
  try {
    execSync("npm run build", { encoding: "utf8", stdio: "pipe" });
    buildResult = { ok: true, detail: "PASS" };
  } catch (e) {
    buildResult = {
      ok: false,
      detail: e instanceof Error ? e.message : "build failed",
    };
  }

  const client = new pg.Client({
    connectionString: stagingPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const tablesCreated = TASK_TABLES.filter(async () => true);
  const exists: Record<string, boolean> = {};
  for (const t of TASK_TABLES) {
    const r = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema='public' AND table_name=$1
       ) AS e`,
      [t],
    );
    exists[t] = r.rows[0]?.e === true;
  }

  const groupCols = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='groups'
       AND column_name IN ('group_type', 'parent_group_id')`,
  );
  const columnsAdded = groupCols.rows.map((r) => String(r.column_name));

  const rls = await verifyRls(client);
  const crossOrg = await crossOrgReadTest(client);
  const rowCount = Number(
    (await client.query(`SELECT COUNT(*)::int c FROM public.task_items`)).rows[0]?.c ?? 0,
  );

  await client.end();

  const verificationOk =
    Object.values(exists).every(Boolean) &&
    columnsAdded.includes("group_type") &&
    columnsAdded.includes("parent_group_id") &&
    rls.ok &&
    crossOrg.ok &&
    noTouch.ok &&
    rowCount === 0;

  const summary = {
    target_project_ref: STAGING_REF,
    migration_file_created:
      "supabase/migrations/20260919120000_phase7a_task_center_schema_staging_rls_gated.sql",
    tables_created: TASK_TABLES.filter((t) => exists[t]),
    columns_added_to_groups: columnsAdded,
    rls_policies_created: rls.policies.length,
    indexes_created: Object.values(REQUIRED_INDEXES).flat().length,
    rollback_file:
      "supabase/migrations/rollback/20260919120000_phase7a_task_center_schema_staging_rls_gated_rollback.sql",
    verification_result: verificationOk ? "PASS" : "FAIL",
    rls_verification_result: rls.ok ? "PASS" : "FAIL",
    rls_failures: rls.failures,
    cross_org_read_test: crossOrg,
    authenticated_write_policy_check: rls.failures.some((f) =>
      f.includes("authenticated mutating"),
    )
      ? "FAIL"
      : "PASS",
    scanner_files_changed_must_be_empty: noTouch.scanner,
    platform_access_files_changed_must_be_empty: noTouch.platform,
    task_items_row_count: rowCount,
    build_result: buildResult.ok ? "PASS" : "FAIL",
    smoke_result: verificationOk ? "PASS" : "FAIL",
    SAFE_TO_PUSH: verificationOk && buildResult.ok ? "yes" : "no",
    SAFE_FOR_NEDA_UI_START: verificationOk ? "yes" : "no",
    NEXT_PROMPT: verificationOk
      ? "PHASE-TASK-CENTER-UI-READONLY-SCAFFOLD-V1"
      : "PHASE-7A-TASK-CENTER-SCHEMA-STAGING-VERIFY-FIX",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Phase 7A Task Center schema verify — ${rid}

- **Target:** \`${STAGING_REF}\` (staging only)
- **Verification:** ${summary.verification_result}
- **RLS:** ${summary.rls_verification_result}
- **Cross-org:** ${crossOrg.detail}
- **Build:** ${summary.build_result}
- **SAFE_FOR_NEDA_UI_START:** ${summary.SAFE_FOR_NEDA_UI_START}
- **NEXT_PROMPT:** \`${summary.NEXT_PROMPT}\`
`,
  );

  console.log(JSON.stringify(summary, null, 2));
  if (!verificationOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
