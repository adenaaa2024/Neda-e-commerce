/**
 * FULL_ORIGINAL_BACKEND_PARITY_APPLY_REQUIRED_NOW
 * Apply delete_cascade v2 on original only.
 *
 *   set APPROVED_FULL_ORIGINAL_BACKEND_PARITY_REQUIRED_NOW=true
 *   npx tsx scripts/full-original-backend-parity-apply-required-now.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const MIGRATION = "supabase/migrations/20260903120000_delete_cascade_undo_audit_foundation_v2.sql";
const AUDIT_PACK = ".cursor/audit-reports/full-original-parity/20260605T044211Z";
const VERIFY_SQL = path.join(AUDIT_PACK, "08_verify_full_backend_parity.sql");

const V2_RPCS = [
  "delete_return_item_with_expected_release",
  "delete_package_cascade",
  "delete_pallet_cascade",
  "move_return_item_parent",
  "preview_restore_undo_batch",
  "apply_restore_undo_batch",
  "restore_deleted_entity",
] as const;

const COUNT_TABLES = ["return_items", "packages", "pallets", "audit_events", "undo_snapshots"] as const;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromUrl(url: string): string | null {
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

async function fnSigs(c: pg.Client, name: string): Promise<string[]> {
  const r = await c.query<{ sig: string }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS sig
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname=$1 ORDER BY sig`,
    [name],
  );
  return r.rows.map((x) => x.sig);
}

async function tableExists(c: pg.Client, t: string): Promise<boolean> {
  const r = await c.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${t}`]);
  return Boolean(r.rows[0]?.e);
}

async function columns(c: pg.Client, t: string): Promise<string[]> {
  const r = await c.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [t],
  );
  return r.rows.map((x) => x.column_name);
}

async function countRows(c: pg.Client, t: string): Promise<number | null> {
  if (!(await tableExists(c, t))) return null;
  const r = await c.query<{ c: string }>(`SELECT count(*)::bigint AS c FROM public.${t}`);
  return Number(r.rows[0]?.c ?? 0);
}

async function snapshot(client: pg.Client, label: string): Promise<Record<string, unknown>> {
  const snap: Record<string, unknown> = { label, row_counts: {}, columns: {}, functions: {} };
  for (const t of COUNT_TABLES) {
    (snap.row_counts as Record<string, number | null>)[t] = await countRows(client, t);
  }
  for (const t of ["return_items", "packages", "pallets", "organization_settings"]) {
    (snap.columns as Record<string, string[]>)[t] = await columns(client, t);
  }
  for (const fn of V2_RPCS) {
    (snap.functions as Record<string, string[]>)[fn] = await fnSigs(client, fn);
  }
  for (const t of ["audit_events", "undo_snapshots"]) {
    (snap as Record<string, unknown>)[`${t}_exists`] = await tableExists(client, t);
  }
  return snap;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const approved = process.env.APPROVED_FULL_ORIGINAL_BACKEND_PARITY_REQUIRED_NOW?.trim().toLowerCase() === "true";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";

  const originalRef = refFromUrl(originalUrl);
  const stagingRef = refFromUrl(stagingUrl);

  const rid = runId();
  const outDir = path.join(process.cwd(), AUDIT_PACK, `apply-required-now-${rid}`);
  fs.mkdirSync(outDir, { recursive: true });

  const report: Record<string, unknown> = {
    target_ref_confirmed: originalRef === ORIGINAL_REF,
    staging_ref: stagingRef,
    original_ref: originalRef,
    approval_flag: approved,
    migration_file: MIGRATION,
    migration_applied: false,
    postgrest_schema_reload: false,
    out_dir: outDir,
    rollback_notes_location: path.join(AUDIT_PACK, "99_rollback_notes.md"),
  };

  if (originalRef !== ORIGINAL_REF) {
    report.error = `ORIGINAL_DIRECT_POSTGRES_URL must target ${ORIGINAL_REF}, got ${originalRef}`;
    fs.writeFileSync(path.join(outDir, "apply-result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  if (!approved) {
    report.error = "APPROVED_FULL_ORIGINAL_BACKEND_PARITY_REQUIRED_NOW=true required";
    fs.writeFileSync(path.join(outDir, "apply-result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const original = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
  const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
  await original.connect();
  await staging.connect();
  await original.query("SET statement_timeout = '600s'");

  const before = await snapshot(original, "before");
  fs.writeFileSync(path.join(outDir, "01_pre_apply_snapshot.json"), JSON.stringify(before, null, 2));

  // Backup function defs if any exist
  const fnBackup: Record<string, string | null> = {};
  for (const fn of V2_RPCS) {
    const r = await original.query<{ def: string | null }>(
      `SELECT pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname=$1 LIMIT 1`,
      [fn],
    );
    fnBackup[fn] = r.rows[0]?.def ?? null;
  }
  fs.writeFileSync(path.join(outDir, "02_pre_apply_function_backup.json"), JSON.stringify(fnBackup, null, 2));

  let applyError: string | null = null;
  const alreadyHadAll =
    (await tableExists(original, "audit_events")) &&
    (await tableExists(original, "undo_snapshots")) &&
    V2_RPCS.every(async (fn) => (await fnSigs(original, fn)).length > 0);

  const hadAudit = await tableExists(original, "audit_events");
  const hadUndo = await tableExists(original, "undo_snapshots");
  const rpcBefore = Object.fromEntries(
    await Promise.all(V2_RPCS.map(async (fn) => [fn, await fnSigs(original, fn)] as const)),
  );
  const needsApply =
    !hadAudit ||
    !hadUndo ||
    V2_RPCS.some((fn) => (rpcBefore[fn] as string[]).length === 0);

  if (needsApply) {
    const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
    try {
      await original.query(sql);
      report.migration_applied = true;
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
      report.apply_error = applyError;
    }
  } else {
    report.migration_applied = false;
    report.skipped = "already_present";
  }

  if (report.migration_applied) {
    try {
      await original.query(`NOTIFY pgrst, 'reload schema'`);
      report.postgrest_schema_reload = true;
    } catch (e) {
      report.postgrest_reload_error = e instanceof Error ? e.message : String(e);
    }
  }

  const after = await snapshot(original, "after");
  fs.writeFileSync(path.join(outDir, "03_post_apply_snapshot.json"), JSON.stringify(after, null, 2));

  const rowCountsChanged: Record<string, { before: number | null; after: number | null }> = {};
  for (const t of COUNT_TABLES) {
    const b = (before.row_counts as Record<string, number | null>)[t];
    const a = (after.row_counts as Record<string, number | null>)[t];
    rowCountsChanged[t] = { before: b ?? null, after: a ?? null };
  }
  report.row_counts_changed = rowCountsChanged;

  const dataLoss =
    (rowCountsChanged.return_items.before ?? 0) > (rowCountsChanged.return_items.after ?? 0) ||
    (rowCountsChanged.packages.before ?? 0) > (rowCountsChanged.packages.after ?? 0) ||
    (rowCountsChanged.pallets.before ?? 0) > (rowCountsChanged.pallets.after ?? 0);
  report.destructive_data_loss = dataLoss;

  // RPC signature parity vs staging
  const parity: Record<string, { staging: string[]; original: string[]; match: boolean }> = {};
  for (const fn of V2_RPCS) {
    const ss = await fnSigs(staging, fn);
    const os = await fnSigs(original, fn);
    const missing = ss.filter((s) => !os.includes(s));
    parity[fn] = { staging: ss, original: os, match: missing.length === 0 && ss.length === os.length };
  }
  report.rpc_signature_parity_result = parity;
  report.all_v2_rpcs_match_staging = Object.values(parity).every((p) => p.match);

  // Column checks
  const requiredCols = {
    return_items: ["deleted_by", "undo_batch_id"],
    packages: ["deleted_by", "undo_batch_id"],
    pallets: ["deleted_by", "undo_batch_id"],
    organization_settings: ["undo_snapshot_retention_days"],
  };
  const colCheck: Record<string, Record<string, boolean>> = {};
  for (const [t, cols] of Object.entries(requiredCols)) {
    const oc = await columns(original, t);
    colCheck[t] = Object.fromEntries(cols.map((c) => [c, oc.includes(c)]));
  }
  report.required_columns_present = colCheck;
  report.audit_events_exists = await tableExists(original, "audit_events");
  report.undo_snapshots_exists = await tableExists(original, "undo_snapshots");

  // Verify SQL
  const verifySql = fs.readFileSync(path.join(process.cwd(), VERIFY_SQL), "utf8");
  const statements = verifySql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"));
  const verifyResults: unknown[] = [];
  for (const stmt of statements) {
    try {
      const r = await original.query(stmt);
      verifyResults.push({ sql: stmt.slice(0, 80), row_count: r.rowCount, sample: r.rows.slice(0, 5) });
    } catch (e) {
      verifyResults.push({ sql: stmt.slice(0, 80), error: e instanceof Error ? e.message : String(e) });
    }
  }
  report.verify_sql_result = verifyResults;
  fs.writeFileSync(path.join(outDir, "04_verify_sql_result.json"), JSON.stringify(verifyResults, null, 2));

  // Probe allocate still works (scanner save dependency)
  let allocateOk = false;
  try {
    const probe = await original.query(
      `SELECT * FROM public.allocate_expected_items_for_return_item_ids(
        ARRAY['00000000-0000-0000-0000-000000000099'::uuid], NULL::uuid, NULL::text) LIMIT 1`,
    );
    allocateOk = Array.isArray(probe.rows);
  } catch {
    allocateOk = false;
  }
  report.scanner_allocate_probe_ok = allocateOk;

  // Probe v2 RPCs compile (call with dummy ids — expect business error not undefined_function)
  const compileProbes: Record<string, string> = {};
  const probes: Array<{ fn: string; sql: string }> = [
    {
      fn: "preview_restore_undo_batch",
      sql: `SELECT public.preview_restore_undo_batch(
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000099'::uuid,
        NULL::uuid, false)`,
    },
    {
      fn: "delete_return_item_with_expected_release",
      sql: `SELECT public.delete_return_item_with_expected_release(
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000099'::uuid,
        NULL::uuid, 'probe', 'probe', NULL::uuid)`,
    },
  ];
  for (const { fn, sql } of probes) {
    try {
      await original.query(sql);
      compileProbes[fn] = "ok";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      compileProbes[fn] = msg.includes("does not exist") ? `MISSING: ${msg}` : `compiled:${msg.slice(0, 120)}`;
    }
  }
  report.delete_undo_compile_probes = compileProbes;

  report.affected_objects_created = {
    tables: ["audit_events", "undo_snapshots"].filter(
      (t) => !(before as Record<string, boolean>)[`${t}_exists`] && (after as Record<string, boolean>)[`${t}_exists`],
    ),
    columns_added: colCheck,
    rpcs: V2_RPCS.filter((fn) => (rpcBefore[fn] as string[]).length === 0 && parity[fn].original.length > 0),
  };

  report.remaining_required_backend_gaps = [
    "background_jobs + job_* tables (SAFE_TO_DEFER)",
    "platform_settings.automation_settings column (SAFE_TO_DEFER)",
    "product_identifier_map bulk sync (−4085 rows, separate approval)",
    "claim_cases performance indexes (RECOMMENDED_PERFORMANCE)",
  ];

  report.SAFE_TO_RETEST_MOBILE_SCANNER_DELETE_VOID_UNDO =
    !applyError &&
    report.audit_events_exists &&
    report.undo_snapshots_exists &&
    report.all_v2_rpcs_match_staging &&
    !dataLoss &&
    allocateOk
      ? "yes"
      : "no";

  await original.end();
  await staging.end();

  fs.writeFileSync(path.join(outDir, "apply-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (applyError || !report.all_v2_rpcs_match_staging || dataLoss) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
