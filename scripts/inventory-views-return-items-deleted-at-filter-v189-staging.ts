/**
 * INVENTORY-VIEWS-RETURN-ITEMS-DELETED-AT-FILTER-V189
 *
 *   npx tsx scripts/inventory-views-return-items-deleted-at-filter-v189-staging.ts --run-id=<id>
 *   npx tsx scripts/inventory-views-return-items-deleted-at-filter-v189-staging.ts --run-id=<id> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const MIGRATION = "20260825120000_inventory_views_return_items_deleted_at_filter_v189.sql";
const APPROVAL_PATH = ".cursor/operator-approvals/inventory-views-return-items-deleted-at-filter-v189-approval.md";
const OUT_BASE = ".cursor/audit-reports/inventory-views-return-items-deleted-at-filter-v189";
const FORBIDDEN = [
  /\bDROP\s+(TABLE|VIEW|SCHEMA)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bpackage_items\b/i,
  /\bFROM\s+public\.returns\b/i,
];

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): boolean {
  return /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(
    fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8"),
  );
}

function sqlWithoutComments(sql: string): string {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function preflightSql(sql: string): { pass: boolean; checks: Record<string, boolean>; notes: string[] } {
  const notes: string[] = [];
  const body = sqlWithoutComments(sql);
  const createCount = (body.match(/^CREATE\s+OR\s+REPLACE\s+VIEW/gim) ?? []).length;
  const checks: Record<string, boolean> = {
    only_one_view_replaced: createCount === 1,
    deleted_at_filter: /\bWHERE\s+r\.deleted_at\s+IS\s+NULL\b/i.test(body),
    no_destructive_ddl: !FORBIDDEN.slice(0, 4).some((re) => re.test(body)),
    no_package_items: !FORBIDDEN[4].test(body),
    no_legacy_returns: !FORBIDDEN[5].test(body),
    uses_return_items: /\bpublic\.return_items\b/i.test(body),
  };
  if (createCount !== 1) notes.push(`Expected 1 CREATE OR REPLACE VIEW, found ${createCount}`);
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks, notes };
}

async function verifyCounts(client: pg.Client): Promise<Record<string, unknown>> {
  const active = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.return_items WHERE deleted_at IS NULL`,
  );
  const softDeleted = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.return_items WHERE deleted_at IS NOT NULL`,
  );
  const viewSum = await client.query(
    `SELECT COALESCE(SUM(total_scanned), 0)::bigint AS scanned_sum FROM public.v_scanned_items_counted`,
  );
  const activeSum = await client.query(
    `SELECT COUNT(*)::int AS line_count FROM public.return_items WHERE deleted_at IS NULL`,
  );
  return {
    active_return_items: active.rows[0]?.c,
    soft_deleted_return_items: softDeleted.rows[0]?.c,
    v_scanned_items_counted_sum_total_scanned: viewSum.rows[0]?.scanned_sum,
    active_return_items_row_count: activeSum.rows[0]?.line_count,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const prodUrl = process.env.PRODUCTION_DIRECT_POSTGRES_URL?.trim() || "";

  const sqlPath = path.join(process.cwd(), "supabase/migrations", MIGRATION);
  const sql = fs.readFileSync(sqlPath, "utf8");
  const preflight = preflightSql(sql);

  const targetOk =
    stagingRef === STAGING_REF && dbUrl.length > 0 && supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF);
  const notProduction = !dbUrl || dbUrl !== prodUrl;

  fs.writeFileSync(
    path.join(outDir, "preflight.json"),
    JSON.stringify(
      {
        run_id: runId,
        staging_ref: STAGING_REF,
        migration: MIGRATION,
        preflight,
        target_ok: targetOk,
        not_production: notProduction,
        approval: readApproval(),
        apply_requested: apply,
      },
      null,
      2,
    ),
  );

  if (!targetOk || !preflight.pass || !notProduction) {
    console.error(JSON.stringify({ ok: false, phase: "preflight" }, null, 2));
    process.exit(2);
  }

  if (!apply) {
    fs.writeFileSync(
      path.join(outDir, "plan-summary.md"),
      [
        "# V189 deleted_at filter — plan",
        "",
        "Migration adds `WHERE r.deleted_at IS NULL` to `v_scanned_items_counted`.",
        "",
        "Run with `--apply` after `APPROVED_TO_RUN_STAGING=true` on operator approval file.",
      ].join("\n"),
    );
    console.log(JSON.stringify({ ok: true, phase: "preflight_only", run_id: runId, out_dir: outDir }, null, 2));
    return;
  }

  if (!readApproval()) {
    throw new Error(`Set APPROVED_TO_RUN_STAGING=true in ${APPROVAL_PATH}`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const before = await verifyCounts(client);
    await client.query(sql);
    const def = await client.query(
      `SELECT pg_get_viewdef('public.v_scanned_items_counted'::regclass, true) AS def`,
    );
    const after = await verifyCounts(client);
    const hasFilter = /\bdeleted_at\s+IS\s+NULL\b/i.test(String(def.rows[0]?.def ?? ""));

    const manifest = {
      prompt: "INVENTORY-VIEWS-RETURN-ITEMS-DELETED-AT-FILTER-V189",
      run_id: runId,
      staging_ref: STAGING_REF,
      migration: MIGRATION,
      mode: "apply",
      view_def_has_deleted_at_filter: hasFilter,
      counts_before: before,
      counts_after: after,
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(outDir, "apply-summary.md"),
      [
        "# V189 apply summary",
        "",
        `- deleted_at filter in viewdef: **${hasFilter}**`,
        `- active return_items: ${before.active_return_items} → ${after.active_return_items}`,
        `- soft-deleted return_items: ${before.soft_deleted_return_items}`,
        `- v_scanned sum(total_scanned): ${before.v_scanned_items_counted_sum_total_scanned} → ${after.v_scanned_items_counted_sum_total_scanned}`,
      ].join("\n"),
    );
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
