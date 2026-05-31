/**
 * INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION
 *   npx tsx scripts/inventory-views-bulk-orphan-ri-exclusion-migration-execute.ts --apply [--run-id=<UTC>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/phase1-latest-stash-land";
const APPROVAL_PATH = ".cursor/operator-approvals/inventory-views-bulk-orphan-ri-exclusion-staging-approval.md";
const MIGRATION_FILE = "supabase/migrations/20260904120000_inventory_views_bulk_orphan_ri_exclusion.sql";
const AUDIT_READONLY = ".cursor/audit-reports/inventory-and-scanner-views-orphan-ri-exclusion-readonly";
const OUT_BASE = ".cursor/audit-reports/inventory-views-bulk-orphan-ri-exclusion-migration";
const PARITY_SNAP =
  ".cursor/audit-reports/inventory-views-bulk-orphan-ri-exclusion-migration/_original-snapshot";

const VIEWS = ["v_scanned_items_counted", "v_inventory_item_status", "v_inventory_status"] as const;

const EXPECTED_COLUMNS: Record<(typeof VIEWS)[number], string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const v of VIEWS) {
    const p = path.join(process.cwd(), PARITY_SNAP, `${v}.columns.json`);
    if (fs.existsSync(p)) {
      out[v] = JSON.parse(fs.readFileSync(p, "utf8")) as string[];
    }
  }
  return out as Record<(typeof VIEWS)[number], string[]>;
})();

const BULK_ORPHAN_PREDICATE = `
  ri.deleted_at IS NULL
  AND ri.expected_item_id IS NOT NULL
  AND ri.package_id IS NULL
  AND ri.pallet_id IS NULL
`;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): boolean {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_INVENTORY_VIEWS_BULK_ORPHAN_RI_EXCLUSION_STAGING\s*=\s*true/i.test(text) &&
    /TARGET_SUPABASE_REF\s*=\s*eiqfaapyumhixxoeltgu/i.test(text)
  );
}

async function viewColumns(client: pg.Client, view: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1
     ORDER BY ordinal_position`,
    [view],
  );
  return (r.rows as { column_name: string }[]).map((x) => x.column_name);
}

async function captureRollback(client: pg.Client): Promise<string> {
  const parts: string[] = [
    "-- Rollback captured immediately before bulk-orphan RI exclusion apply",
    `-- staging ref: ${STAGING_REF}`,
    "",
    "BEGIN;",
    "DROP VIEW IF EXISTS public.v_inventory_status CASCADE;",
    "DROP VIEW IF EXISTS public.v_inventory_item_status CASCADE;",
    "DROP VIEW IF EXISTS public.v_scanned_items_counted CASCADE;",
    "",
  ];
  for (const v of VIEWS) {
    const def = await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [`public.${v}`]);
    parts.push(`CREATE VIEW public.${v} AS`, String(def.rows[0]?.def ?? "").trim(), ";", "");
  }
  parts.push("NOTIFY pgrst, 'reload schema';", "COMMIT;");
  return parts.join("\n");
}

async function metrics(client: pg.Client): Promise<Record<string, unknown>> {
  const r = await client.query(`
    SELECT
      (SELECT count(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS active_ri,
      (SELECT count(*)::int FROM public.return_items ri WHERE ${BULK_ORPHAN_PREDICATE}) AS bulk_orphan_active,
      (SELECT count(*)::int FROM public.return_items ri
         WHERE ri.deleted_at IS NULL AND ri.package_id IS NOT NULL) AS package_anchored_active,
      (SELECT coalesce(sum(total_scanned),0)::numeric FROM public.v_scanned_items_counted) AS v_scanned_sum,
      (SELECT coalesce(sum(total_scanned),0)::numeric FROM public.v_inventory_item_status) AS v_item_sum,
      (SELECT coalesce(sum(total_expected),0)::numeric FROM public.v_inventory_item_status) AS v_item_expected_sum,
      (SELECT count(*)::int FROM public.expected_packages) AS ep_count,
      (SELECT count(*)::int FROM public.products) AS products_count,
      (SELECT count(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS pim_count,
      (SELECT count(*)::int FROM public.v_inventory_item_status
         WHERE total_scanned > 0 AND tracking_number IS NULL) AS item_rows_scanned_null_tracking
  `);
  const def = await client.query(
    `SELECT pg_get_viewdef('public.v_scanned_items_counted'::regclass, true) AS d`,
  );
  const viewdef = String((def.rows[0] as { d: string })?.d ?? "");
  return {
    ...(r.rows[0] as Record<string, unknown>),
    view_has_package_gate: /package_id IS NOT NULL/i.test(viewdef),
    view_has_deleted_at: /deleted_at IS NULL/i.test(viewdef),
    view_has_bulk_not: /expected_item_id IS NOT NULL[\s\S]*package_id IS NULL/i.test(viewdef),
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const blockers: string[] = [];
  let branch = "unknown";
  try {
    branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    blockers.push("Could not read git branch");
  }
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch ${branch} !== ${REQUIRED_BRANCH}`);
  if (!readApproval()) blockers.push("Approval flags not true");
  if (!fs.existsSync(path.join(process.cwd(), MIGRATION_FILE))) blockers.push(`Missing ${MIGRATION_FILE}`);

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const ref = refFromSupabaseUrl(dbUrl) ?? refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF) && getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Connection must target staging ${STAGING_REF} (parsed ${ref ?? "null"})`);
  }
  if (dbUrl.includes(ORIGINAL_REF)) blockers.push("Original ref in connection URL");

  fs.copyFileSync(
    path.join(process.cwd(), MIGRATION_FILE),
    path.join(outDir, "ddl-staging-apply.sql"),
  );
  if (apply && !Object.keys(EXPECTED_COLUMNS).length) {
    blockers.push(
      `Missing parity snapshot under ${PARITY_SNAP} — run build-inventory-views-bulk-orphan-migration.ts after dumping original viewdefs`,
    );
  }
  const patchesSrc = path.join(process.cwd(), AUDIT_READONLY);
  if (fs.existsSync(patchesSrc)) {
    const dirs = fs.readdirSync(patchesSrc).filter((d) => fs.statSync(path.join(patchesSrc, d)).isDirectory());
    const latest = dirs.sort().pop();
    if (latest) {
      const p = path.join(patchesSrc, latest, "REQUIRED_PATCHES.md");
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(outDir, "REQUIRED_PATCHES.md"));
    }
  }

  if (!apply || blockers.length) {
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ status: blockers.length ? "BLOCKED" : "DRY_RUN", blockers, run_id: runId }, null, 2),
    );
    console.log(JSON.stringify({ ok: !blockers.length, outDir, apply: false, blockers }, null, 2));
    if (blockers.length) process.exit(1);
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const colsBefore: Record<string, string[]> = {};
  for (const v of VIEWS) colsBefore[v] = await viewColumns(client, v);
  const before = await metrics(client);
  const preRollback = await captureRollback(client);
  fs.writeFileSync(path.join(outDir, "pre-apply-viewdefs.sql"), preRollback + "\n");
  fs.writeFileSync(path.join(outDir, "ROLLBACK_DDL.md"), preRollback + "\n");

  const migrationSql = fs.readFileSync(path.join(process.cwd(), MIGRATION_FILE), "utf8");
  await client.query(migrationSql);

  const colsAfter: Record<string, string[]> = {};
  for (const v of VIEWS) colsAfter[v] = await viewColumns(client, v);
  const after = await metrics(client);

  const epBefore = before.ep_count;
  const epAfter = after.ep_count;
  const lostCols = Object.keys(colsBefore).flatMap((v) =>
    colsBefore[v]!.filter((c) => !colsAfter[v]!.includes(c)).map((c) => `${v}.${c}`),
  );
  const missingParity = VIEWS.flatMap((v) => {
    const expected = EXPECTED_COLUMNS[v] ?? [];
    return expected.filter((c) => !colsAfter[v]!.includes(c)).map((c) => `${v}.${c}`);
  });
  const parityOk =
    missingParity.length === 0 &&
    VIEWS.every((v) => (EXPECTED_COLUMNS[v]?.length ?? 0) === colsAfter[v]!.length);

  if (Number(before.active_ri) !== 33) blockers.push(`active return_items ${before.active_ri} !== 33`);
  if (Number(before.bulk_orphan_active) !== 0) {
    blockers.push(`bulk_orphan_active ${before.bulk_orphan_active} !== 0`);
  }
  if (Number(before.package_anchored_active) !== 3) {
    blockers.push(`package_anchored_active ${before.package_anchored_active} !== 3`);
  }
  if (Number(before.v_scanned_sum) !== 3) blockers.push(`v_scanned_sum before ${before.v_scanned_sum} !== 3`);
  if (String(epBefore) !== String(epAfter)) blockers.push(`expected_packages count changed ${epBefore} -> ${epAfter}`);
  if (String(before.products_count) !== String(after.products_count)) {
    blockers.push(`products count changed ${before.products_count} -> ${after.products_count}`);
  }
  if (String(before.pim_count) !== String(after.pim_count)) {
    blockers.push(`product_identifier_map count changed ${before.pim_count} -> ${after.pim_count}`);
  }
  if (missingParity.length) blockers.push(`Missing parity columns: ${missingParity.join(", ")}`);
  if (lostCols.length && !parityOk) blockers.push(`View columns dropped after apply: ${lostCols.join(", ")}`);
  if (!after.view_has_package_gate) blockers.push("v_scanned_items_counted missing package_id gate after apply");
  if (Number(after.v_scanned_sum) !== 3) blockers.push(`v_scanned_sum after ${after.v_scanned_sum} !== 3`);

  const mv = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='mv_daily_store_analytics' AND c.relkind='m'
     ) AS ok`,
  );
  const hasMv = Boolean((mv.rows[0] as { ok: boolean }).ok);

  await client.end();

  const pass = blockers.length === 0;

  const report = [
    "# INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION",
    "",
    `Run: \`${runId}\` · Staging: \`${STAGING_REF}\``,
    "",
    "# DDL_APPLIED",
    "",
    pass ? "**YES** — `20260904120000_inventory_views_bulk_orphan_ri_exclusion.sql`" : "**NO** — blocked",
    "",
    "Gate used (physical scan): `return_items.deleted_at IS NULL AND return_items.package_id IS NOT NULL` (INNER JOIN packages).",
    "",
    "Loose-item scan path: operator UI may allow slip-only intake, but **inventory physical-count views intentionally exclude package-less rows** (aligned with `isPhysicalReturnItemForClaims`). Expected spine still reads `expected_packages` unchanged.",
    "",
    "# BEFORE_AFTER_VIEW_COUNTS",
    "",
    "| Metric | Before | After |",
    "|--------|-------:|------:|",
    `| active return_items | ${before.active_ri} | ${after.active_ri} |`,
    `| bulk orphan (active predicate) | ${before.bulk_orphan_active} | ${after.bulk_orphan_active} |`,
    `| package-anchored active RI | ${before.package_anchored_active} | ${after.package_anchored_active} |`,
    `| SUM(v_scanned_items_counted.total_scanned) | ${before.v_scanned_sum} | ${after.v_scanned_sum} |`,
    `| SUM(v_inventory_item_status.total_scanned) | ${before.v_item_sum} | ${after.v_item_sum} |`,
    `| SUM(v_inventory_item_status.total_expected) | ${before.v_item_expected_sum} | ${after.v_item_expected_sum} |`,
    `| expected_packages rows | ${before.ep_count} | ${after.ep_count} |`,
    `| item rows scanned w/ null tracking | ${before.item_rows_scanned_null_tracking} | ${after.item_rows_scanned_null_tracking} |`,
    "",
    "# DEPENDENT_VIEWS",
    "",
    "| View | Recreated | Columns before → after |",
    "|------|-----------|-------------------------|",
    ...VIEWS.map(
      (v) =>
        `| \`${v}\` | CASCADE drop + create | ${colsBefore[v]!.length} → ${colsAfter[v]!.length}${lostCols.some((x) => x.startsWith(v)) ? " **column loss**" : ""} |`,
    ),
    "",
    hasMv
      ? "| `mv_daily_store_analytics` | **Present** — not refreshed in this run; schedule separate MV refresh if counts still inflated |"
      : "| `mv_daily_store_analytics` | Not present on staging |",
    "",
    "Downstream app reads (unchanged by this migration): `fetchVInventoryStatusForScanCode`, scanner shipment table, expected_packages resolver paths.",
    "",
    "# ROLLBACK_DDL",
    "",
    "See `ROLLBACK_DDL.md` / `pre-apply-viewdefs.sql` in this folder (captured immediately before this apply).",
    "",
    "# VERIFICATION",
    "",
    pass ? "**PASS**" : "**FAIL**",
    "",
    "## COLUMN_PARITY",
    "",
    parityOk ? "**PASS** — column sets match `_original-snapshot`" : `**FAIL** — missing: ${missingParity.join(", ") || "count mismatch"}`,
    "",
    ...(VIEWS.map(
      (v) =>
        `- \`${v}\`: ${colsBefore[v]!.length} → ${colsAfter[v]!.length} (expected ${EXPECTED_COLUMNS[v]?.length ?? "?"})`,
    )),
    "",
    "## SAFE_TO_CONTINUE",
    "",
    pass ? "**yes**" : "**no**",
    "",
    ...(blockers.length ? ["", "## Blockers", "", ...blockers.map((b) => `- ${b}`)] : []),
    "",
    "# NEXT_TS_GUARD_PROMPT",
    "",
    "```",
    "SCANNER-ACTIVE-SCAN-COUNTS-BULK-ORPHAN-GUARD",
    "```",
    "",
    "Optional follow-up: `CLAIM-RETURN-LINE-BACKFILL-PHYSICAL-ANCHOR-GATE`",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "INVENTORY_VIEWS_BULK_ORPHAN_RI_EXCLUSION_MIGRATION.md"), report + "\n");
  fs.writeFileSync(
    path.join(outDir, "before-after-view-counts.json"),
    JSON.stringify({ before, after, colsBefore, colsAfter }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION",
        run_id: runId,
        status: pass ? "PASS" : "FAIL",
        ddl_applied: pass,
        migration_file: MIGRATION_FILE,
        blockers,
        before,
        after,
        colsBefore,
        colsAfter,
        column_parity_ok: parityOk,
        safe_to_continue: pass,
        next_prompt: "SCANNER-ACTIVE-SCAN-COUNTS-BULK-ORPHAN-GUARD",
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: pass, outDir, before, after, blockers }, null, 2));
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
