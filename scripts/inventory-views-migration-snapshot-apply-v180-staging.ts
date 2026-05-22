/**
 * INVENTORY-VIEWS-MIGRATION-SNAPSHOT-APPLY-STAGING-V180
 * Preflight + apply single migration via STAGING_DIRECT_POSTGRES_URL (staging ref guard).
 *
 *   npx tsx scripts/inventory-views-migration-snapshot-apply-v180-staging.ts --run-id=<id>
 *   npx tsx scripts/inventory-views-migration-snapshot-apply-v180-staging.ts --run-id=<id> --apply
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
const MIGRATION = "20260824120000_inventory_views_neda_snapshot_v180.sql";
const FORBIDDEN = [
  /\bDROP\s+(TABLE|VIEW|SCHEMA)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bpackage_items\b/i,
  /\bFROM\s+public\.returns\b/i,
  /\bJOIN\s+public\.returns\b/i,
  /\bLEFT\s+JOIN\s+public\.products\b/i,
];

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
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
    staging_ref_constant: STAGING_REF === "eiqfaapyumhixxoeltgu",
    only_create_or_replace_view: createCount === 3 && !/\bCREATE\s+TABLE\b/i.test(body),
    no_destructive_ddl: !FORBIDDEN.slice(0, 4).some((re) => re.test(body)),
    no_package_items: !FORBIDDEN[4].test(body),
    no_legacy_returns_table: !FORBIDDEN[5].test(body) && !FORBIDDEN[6].test(body),
    no_products_join_in_view: !FORBIDDEN[7].test(body),
    uses_return_items: /\bpublic\.return_items\b/i.test(body),
  };
  if (createCount !== 3) notes.push(`Expected 3 CREATE OR REPLACE VIEW statements, found ${createCount}`);
  for (const [k, v] of Object.entries(checks)) {
    if (!v) notes.push(`FAIL: ${k}`);
  }
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks, notes };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/inventory-views-migration-snapshot-apply-v180",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const prodUrl = process.env.PRODUCTION_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";

  const sqlPath = path.join(process.cwd(), "supabase/migrations", MIGRATION);
  const sql = fs.readFileSync(sqlPath, "utf8");
  const preflight = preflightSql(sql);

  const targetOk =
    stagingRef === STAGING_REF &&
    dbUrl.length > 0 &&
    supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF);
  const notProduction = !dbUrl || dbUrl !== prodUrl;
  const notOriginal = !dbUrl || dbUrl !== originalUrl;

  const preflightDoc = {
    run_id: runId,
    staging_ref_expected: STAGING_REF,
    staging_ref_from_env: stagingRef,
    staging_direct_postgres_configured: dbUrl.length > 0,
    target_is_staging: targetOk,
    production_not_targeted: notProduction,
    original_not_targeted: notOriginal,
    migration_file: MIGRATION,
    preflight,
    apply_requested: apply,
  };

  fs.writeFileSync(
    path.join(outDir, "preflight.json"),
    JSON.stringify(preflightDoc, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "preflight.md"),
    [
      "# Preflight — inventory views snapshot apply (V180)",
      "",
      `| Check | Result |`,
      `|-------|--------|`,
      `| Staging ref | \`${stagingRef}\` ${targetOk ? "PASS" : "**FAIL**"} |`,
      `| STAGING_DIRECT_POSTGRES_URL | ${dbUrl.length ? "set (ref in host)" : "**missing**"} |`,
      `| Production not targeted | ${notProduction ? "PASS" : "**FAIL**"} |`,
      `| Original not targeted | ${notOriginal ? "PASS" : "**FAIL**"} |`,
      `| CREATE OR REPLACE VIEW only (×3) | ${preflight.checks.only_create_or_replace_view ? "PASS" : "**FAIL**"} |`,
      `| No destructive DDL | ${preflight.checks.no_destructive_ddl ? "PASS" : "**FAIL**"} |`,
      `| No package_items | ${preflight.checks.no_package_items ? "PASS" : "**FAIL**"} |`,
      `| No legacy returns table | ${preflight.checks.no_legacy_returns_table ? "PASS" : "**FAIL**"} |`,
      `| No products join in view | ${preflight.checks.no_products_join_in_view ? "PASS" : "**FAIL**"} |`,
      "",
      ...(preflight.notes.length ? preflight.notes.map((n) => `- ${n}`) : ["- All static checks passed."]),
    ].join("\n"),
  );

  if (!targetOk || !preflight.pass || !notProduction || !notOriginal) {
    console.error(JSON.stringify({ ok: false, phase: "preflight", ...preflightDoc }, null, 2));
    process.exit(2);
  }

  if (!apply) {
    console.log(
      JSON.stringify(
        { ok: true, phase: "preflight_only", run_id: runId, out_dir: outDir, hint: "Re-run with --apply" },
        null,
        2,
      ),
    );
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const pkg = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='package_items'`,
    );
    if ((pkg.rowCount ?? 0) > 0) {
      throw new Error("package_items table exists — abort");
    }
    await client.query(sql);
    const views = await client.query(
      `SELECT table_name FROM information_schema.views
       WHERE table_schema='public' AND table_name = ANY($1::text[])`,
      [["v_scanned_items_counted", "v_inventory_item_status", "v_inventory_status"]],
    );
    fs.writeFileSync(
      path.join(outDir, "apply-result.json"),
      JSON.stringify(
        {
          ok: true,
          applied_via: "STAGING_DIRECT_POSTGRES_URL",
          migration: MIGRATION,
          views_present: views.rows.map((r: { table_name: string }) => r.table_name),
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ok: true, phase: "apply", run_id: runId, out_dir: outDir }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
