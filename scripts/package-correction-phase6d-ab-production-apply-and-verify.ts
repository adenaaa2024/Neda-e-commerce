/**
 * PHASE-6D-A-B-SCANNER-CORRECTION-PRODUCTION-APPLY
 *   npx tsx scripts/package-correction-phase6d-ab-production-apply-and-verify.ts --apply
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MIGRATIONS = [
  "supabase/migrations/20260907120000_phase6d_ab_scanner_correction_backend.sql",
  "supabase/migrations/20260907120100_phase6d_ab_patch_missing_review_fix.sql",
];
const OUT_BASE = ".cursor/audit-reports/package-correction-phase6d-ab-production-apply";

type RpcRow = Record<string, unknown>;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function applyMigrations(client: pg.Client): Promise<string[]> {
  const applied: string[] = [];
  for (const file of MIGRATIONS) {
    const version = path.basename(file).replace(/\.sql$/, "").split("_")[0]!;
    const exists = await client.query(
      `SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1`,
      [version],
    );
    if (exists.rows.length) continue;
    await client.query(fs.readFileSync(path.join(process.cwd(), file), "utf8"));
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [version, path.basename(file)],
    );
    applied.push(file);
  }
  return applied;
}

async function patchMissing(
  client: pg.Client,
  packageId: string,
  slipId: string,
  marked: boolean,
): Promise<RpcRow> {
  const r = await client.query(
    `SELECT public.patch_package_missing_review($1::uuid, $2::uuid, $3::uuid, $4::boolean, 1, false, NULL::uuid) AS payload`,
    [ORG, packageId, slipId, marked],
  );
  return (r.rows[0]?.payload ?? {}) as RpcRow;
}

async function reopen(client: pg.Client, packageId: string): Promise<RpcRow> {
  const r = await client.query(
    `SELECT public.reopen_package_receive_correction($1::uuid, $2::uuid, NULL::uuid, 'smoke') AS payload`,
    [ORG, packageId],
  );
  return (r.rows[0]?.payload ?? {}) as RpcRow;
}

async function finalize(client: pg.Client, packageId: string, emptyBox: boolean): Promise<RpcRow> {
  const r = await client.query(
    `SELECT public.finalize_package_receive_close($1::uuid, $2::uuid, $3::uuid, $4::boolean, NULL::uuid, NULL::text) AS payload`,
    [ORG, packageId, STORE, emptyBox],
  );
  return (r.rows[0]?.payload ?? {}) as RpcRow;
}

async function runSmokes(client: pg.Client): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const slipId = randomUUID();
  const sessionId = randomUUID();

  await client.query("BEGIN");
  try {
    const pkg = await client.query(
      `INSERT INTO packages (organization_id, store_id, package_code, status, manifest_data)
       VALUES ($1::uuid, $2::uuid, $3, 'open', '{}'::jsonb)
       RETURNING id::text`,
      [ORG, STORE, `P6D-PROD-${sessionId}`],
    );
    const packageId = String(pkg.rows[0]?.id);

    const riBefore = (
      await client.query(`SELECT count(*)::int AS c FROM return_items WHERE package_id=$1::uuid`, [packageId])
    ).rows[0]?.c;

    const markOpen = await patchMissing(client, packageId, slipId, true);
    const manifestAfterMark = (
      await client.query(`SELECT manifest_data FROM packages WHERE id=$1::uuid`, [packageId])
    ).rows[0]?.manifest_data as Record<string, unknown>;
    const ois = (manifestAfterMark?.operator_item_scan ?? {}) as Record<string, unknown>;
    const missing = (ois.missing_review ?? {}) as Record<string, unknown>;
    const bySlip = (missing.by_slip_content_id ?? {}) as Record<string, unknown>;

    out.missing_review_patch_open = {
      pass: markOpen.ok === true && bySlip[slipId] != null,
      rpc: markOpen,
      manifest_path: "packages.manifest_data.operator_item_scan.missing_review",
    };

    const unmark = await patchMissing(client, packageId, slipId, false);
    const manifestAfterUnmark = (
      await client.query(`SELECT manifest_data FROM packages WHERE id=$1::uuid`, [packageId])
    ).rows[0]?.manifest_data as Record<string, unknown>;
    const ois2 = (manifestAfterUnmark?.operator_item_scan ?? {}) as Record<string, unknown>;
    const bySlip2 = ((ois2.missing_review as Record<string, unknown>)?.by_slip_content_id ?? {}) as Record<
      string,
      unknown
    >;

    out.missing_review_unmark_open = {
      pass: unmark.ok === true && bySlip2[slipId] == null,
      rpc: unmark,
    };

    await finalize(client, packageId, false);
    const markFinalized = await patchMissing(client, packageId, slipId, true);
    out.finalized_lock_smoke = {
      pass: markFinalized.ok !== true && markFinalized.error === "package_finalized",
      rpc: markFinalized,
    };

    const reopenRes = await reopen(client, packageId);
    const oisAfterReopen = (
      await client.query(
        `SELECT manifest_data->'operator_item_scan'->>'receive_state' AS state,
                (manifest_data->'operator_item_scan'->>'finalize_revision')::int AS rev
         FROM packages WHERE id=$1::uuid`,
        [packageId],
      )
    ).rows[0];

    const markAfterReopen = await patchMissing(client, packageId, slipId, true);
    out.reopen_smoke = {
      pass:
        reopenRes.ok === true &&
        oisAfterReopen?.state === "open" &&
        Number(oisAfterReopen?.rev) >= 1 &&
        markAfterReopen.ok === true,
      reopen_rpc: reopenRes,
      mark_after_reopen: markAfterReopen,
      state: oisAfterReopen,
    };

    const pkg2 = await client.query(
      `INSERT INTO packages (organization_id, store_id, package_code, status)
       VALUES ($1::uuid, $2::uuid, $3, 'open')
       RETURNING id::text`,
      [ORG, STORE, `P6D-E-PROD-${sessionId}`],
    );
    const packageId2 = String(pkg2.rows[0]?.id);
    await client.query(
      `INSERT INTO return_items (organization_id, store_id, marketplace, item_name, conditions, status, notes, package_id, scanned_quantity)
       VALUES ($1::uuid, $2::uuid, 'amazon', $3, $4::text[], 'received', $5, $6::uuid, 4)`,
      [ORG, STORE, `_p6d_prod_${sessionId}`, ["sellable_ok"], `_fixture_sess:${sessionId}`, packageId2],
    );
    const emptyBoxBlocked = await finalize(client, packageId2, true);
    out.empty_box_guard_smoke = {
      pass: emptyBoxBlocked.ok !== true && emptyBoxBlocked.error === "empty_box_not_allowed_when_scanned",
      rpc: emptyBoxBlocked,
    };

    const riAfter = (
      await client.query(`SELECT count(*)::int AS c FROM return_items WHERE package_id=$1::uuid`, [packageId])
    ).rows[0]?.c;

    out.return_items_not_created_for_missing = {
      pass: Number(riBefore) === 0 && Number(riAfter) === 0,
      before: riBefore,
      after: riAfter,
    };

    const audit = await client.query(
      `SELECT action, count(*)::int AS c FROM audit_events
        WHERE organization_id=$1::uuid AND entity_id=$2::uuid
          AND action IN ('missing_review_patch', 'package_reopen', 'package_finalize')
        GROUP BY action ORDER BY action`,
      [ORG, packageId],
    );

    const auditActions = new Set(audit.rows.map((r: { action: string }) => r.action));
    out.audit_events_written = {
      rows: audit.rows,
      pass:
        auditActions.has("missing_review_patch") &&
        auditActions.has("package_reopen") &&
        auditActions.has("package_finalize"),
    };

    await client.query("ROLLBACK");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  return out;
}

async function schemaDeltaCheck(client: pg.Client): Promise<{ new_tables: number; new_columns: number }> {
  const tables = await client.query(
    `SELECT count(*)::int AS c FROM information_schema.tables
     WHERE table_schema='public' AND table_name LIKE 'phase6d_%'`,
  );
  const cols = await client.query(
    `SELECT count(*)::int AS c FROM information_schema.columns
     WHERE table_schema='public' AND column_name LIKE 'phase6d_%'`,
  );
  return {
    new_tables: Number(tables.rows[0]?.c ?? 0),
    new_columns: Number(cols.rows[0]?.c ?? 0),
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const ref =
    refFromSupabaseUrl(dbUrl) ?? dbUrl.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase() ?? null;
  const blockers: string[] = [];

  if (!dbUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL unset");
  if (ref !== ORIGINAL_REF) blockers.push(`Expected original ref ${ORIGINAL_REF}, got ${ref ?? "null"}`);
  if (dbUrl.includes(STAGING_REF)) blockers.push("BLOCKED: URL targets staging");

  const result: Record<string, unknown> = {
    phase_number: "6D-A-B",
    production_applied: "no",
    new_tables_created: "no",
    new_columns_created: "no",
    missing_review_patch_result: "pending",
    finalized_lock_result: "pending",
    reopen_result: "pending",
    empty_box_guard_result: "pending",
    return_items_not_created: "pending",
    audit_result: "pending",
    build_result: "SKIP",
    SAFE_FOR_LIVE_SCANNER_CORRECTION_BACKEND: "no",
    blockers,
  };

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const fnBefore = await client.query(
    `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='finalize_package_receive_close'`,
  );
  if (!fnBefore.rows.length) {
    blockers.push("phase6B finalize_package_receive_close prerequisite missing on production");
  }

  if (apply && blockers.length === 0) {
    const applied = await applyMigrations(client);
    result.production_applied = applied.length ? "yes" : "already_applied";
    result.migrations_applied = applied.length ? applied : "already_applied";

    const fnAfter = await client.query(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND proname IN ('patch_package_missing_review','reopen_package_receive_correction')`,
    );
    if (fnAfter.rows.length < 2) blockers.push("correction RPCs missing after apply");

    const schemaDelta = await schemaDeltaCheck(client);
    result.new_tables_created = schemaDelta.new_tables === 0 ? "no" : "yes";
    result.new_columns_created = schemaDelta.new_columns === 0 ? "no" : "yes";
    if (schemaDelta.new_tables > 0) blockers.push("unexpected new tables after migration");
    if (schemaDelta.new_columns > 0) blockers.push("unexpected new columns after migration");

    const auditEnum = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'audit_events_action_chk'`,
    );
    result.audit_constraint = auditEnum.rows[0]?.def ?? null;
    if (!String(result.audit_constraint ?? "").includes("missing_review_patch")) {
      blockers.push("audit_events_action_chk missing phase6d actions");
    }

    if (blockers.length === 0) {
      const smokes = await runSmokes(client);
      Object.assign(result, smokes);

      result.missing_review_patch_result =
        (smokes.missing_review_patch_open as { pass?: boolean })?.pass &&
        (smokes.missing_review_unmark_open as { pass?: boolean })?.pass
          ? "PASS"
          : "FAIL";
      result.finalized_lock_result = (smokes.finalized_lock_smoke as { pass?: boolean })?.pass ? "PASS" : "FAIL";
      result.reopen_result = (smokes.reopen_smoke as { pass?: boolean })?.pass ? "PASS" : "FAIL";
      result.empty_box_guard_result = (smokes.empty_box_guard_smoke as { pass?: boolean })?.pass ? "PASS" : "FAIL";
      result.return_items_not_created = (smokes.return_items_not_created_for_missing as { pass?: boolean })?.pass
        ? "yes"
        : "no";
      result.audit_result = (smokes.audit_events_written as { pass?: boolean })?.pass ? "PASS" : "FAIL";
    }
  }

  await client.end();

  let buildOk = false;
  try {
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" });
    buildOk = true;
  } catch (e) {
    result.build_error = e instanceof Error ? e.message : String(e);
  }
  result.build_result = buildOk ? "PASS" : apply ? "FAIL" : "SKIP";

  const smokesPass =
    !apply ||
    (result.missing_review_patch_result === "PASS" &&
      result.finalized_lock_result === "PASS" &&
      result.reopen_result === "PASS" &&
      result.empty_box_guard_result === "PASS" &&
      result.return_items_not_created === "yes" &&
      result.audit_result === "PASS");

  result.SAFE_FOR_LIVE_SCANNER_CORRECTION_BACKEND =
    blockers.length === 0 && buildOk && smokesPass ? "yes" : "no";
  result.blockers = blockers;

  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# Phase 6D-A/B production apply",
      "",
      `- Run: \`${rid}\` · Mode: **${apply ? "APPLY" : "DRY-RUN"}**`,
      `- Target: \`${ORIGINAL_REF}\``,
      `- Migrations: ${MIGRATIONS.map((m) => `\`${path.basename(m)}\``).join(", ")}`,
      "",
      "| Check | Result |",
      "|-------|--------|",
      `| production_applied | ${result.production_applied} |`,
      `| missing_review_patch | ${result.missing_review_patch_result} |`,
      `| finalized_lock | ${result.finalized_lock_result} |`,
      `| reopen | ${result.reopen_result} |`,
      `| empty_box_guard | ${result.empty_box_guard_result} |`,
      `| return_items_not_created | ${result.return_items_not_created} |`,
      `| audit | ${result.audit_result} |`,
      `| build | ${result.build_result} |`,
      `| SAFE_FOR_LIVE | ${result.SAFE_FOR_LIVE_SCANNER_CORRECTION_BACKEND} |`,
    ].join("\n") + "\n",
  );
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ run_id: rid, mode: apply ? "apply" : "dry-run", target: ORIGINAL_REF, migrations: MIGRATIONS }, null, 2),
  );

  console.log(JSON.stringify(result, null, 2));
  if (result.SAFE_FOR_LIVE_SCANNER_CORRECTION_BACKEND !== "yes") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
