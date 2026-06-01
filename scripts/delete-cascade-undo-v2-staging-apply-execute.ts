/**
 * DELETE-CASCADE-UNDO-V2-STAGING-APPLY-EXECUTE — staging-only v2 foundation apply.
 *
 *   npx tsx scripts/delete-cascade-undo-v2-staging-apply-execute.ts --apply [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v3";
const APPROVAL_PATH = ".cursor/operator-approvals/delete-cascade-undo-audit-v2-staging-approval.md";
const MIGRATION_FILE = "supabase/migrations/20260903120000_delete_cascade_undo_audit_foundation_v2.sql";
const DRYRUN_RUN = "20260521T120000Z";
const OUT_BASE = ".cursor/audit-reports/delete-cascade-undo-v2-staging-apply-execute";

const V1_PARTIAL_TABLES = ["audit_events", "undo_snapshots", "restore_conflicts"] as const;
const V2_FUNCTIONS = [
  "preview_restore_undo_batch",
  "apply_restore_undo_batch",
  "delete_package_cascade",
  "delete_pallet_cascade",
] as const;

const ROLLBACK_SQL = `-- Rollback: delete cascade undo v2 (staging only) — see fix-plan rollback-plan.md
BEGIN;
DROP FUNCTION IF EXISTS public.apply_restore_undo_batch CASCADE;
DROP FUNCTION IF EXISTS public.preview_restore_undo_batch CASCADE;
DROP FUNCTION IF EXISTS public.restore_deleted_entity CASCADE;
DROP FUNCTION IF EXISTS public.move_return_item_parent CASCADE;
DROP FUNCTION IF EXISTS public.delete_return_item_with_expected_release CASCADE;
DROP FUNCTION IF EXISTS public.delete_package_cascade CASCADE;
DROP FUNCTION IF EXISTS public.delete_pallet_cascade CASCADE;
DROP FUNCTION IF EXISTS public._ops_log_audit_event CASCADE;
DROP FUNCTION IF EXISTS public._ops_require_permission CASCADE;
DROP FUNCTION IF EXISTS public._ops_active_claims_for_return_item CASCADE;
DROP FUNCTION IF EXISTS public._ops_slip_refs_for_package CASCADE;
DROP FUNCTION IF EXISTS public._ops_expected_allocation_snapshot CASCADE;
DROP FUNCTION IF EXISTS public._ops_undo_capture CASCADE;
DROP FUNCTION IF EXISTS public._ops_undo_batch_start CASCADE;
DROP TABLE IF EXISTS public.restore_conflicts CASCADE;
DROP TABLE IF EXISTS public.undo_snapshots CASCADE;
DROP TABLE IF EXISTS public.audit_events CASCADE;
ALTER TABLE public.pallets DROP COLUMN IF EXISTS deleted_by, DROP COLUMN IF EXISTS undo_batch_id;
ALTER TABLE public.packages DROP COLUMN IF EXISTS deleted_by, DROP COLUMN IF EXISTS undo_batch_id;
ALTER TABLE public.return_items DROP COLUMN IF EXISTS deleted_by, DROP COLUMN IF EXISTS undo_batch_id;
ALTER TABLE public.organization_settings DROP COLUMN IF EXISTS undo_snapshot_retention_days;
DELETE FROM public.permissions WHERE key LIKE 'ops.delete_%'
  OR key LIKE 'ops.%undo%'
  OR key IN (
    'ops.preview_restore_undo_batch','ops.apply_restore_undo_batch',
    'ops.move_return_item_parent','ops.restore_deleted_entity','ops.view_undo_history'
  );
COMMIT;
NOTIFY pgrst, 'reload schema';
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

function readApproval(): { valid: boolean; flags: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const staging = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const v2 = /APPROVED_DELETE_CASCADE_UNDO_AUDIT_V2_MIGRATION\s*=\s*true/i.test(text);
  const target = /TARGET_SUPABASE_REF\s*=\s*eiqfaapyumhixxoeltgu/i.test(text);
  return {
    valid: staging && v2 && target,
    flags: {
      APPROVED_TO_RUN_STAGING: staging ? "true" : "false",
      APPROVED_DELETE_CASCADE_UNDO_AUDIT_V2_MIGRATION: v2 ? "true" : "false",
      TARGET_SUPABASE_REF: target ? "eiqfaapyumhixxoeltgu" : "unset",
    },
  };
}

function refFromConnectionUrl(url: string): string | null {
  return refFromSupabaseUrl(url) ?? url.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase() ?? null;
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=$1
     ) AS ok`,
    [table],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function fnExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = $1
     ) AS ok`,
    [name],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function columnExists(client: pg.Client, table: string, col: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS ok`,
    [table, col],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function retentionDefault(client: pg.Client): Promise<{ column: boolean; defaultExpr: string | null }> {
  const r = await client.query(
    `SELECT column_default
     FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='organization_settings'
       AND column_name='undo_snapshot_retention_days'`,
  );
  const row = r.rows[0] as { column_default: string | null } | undefined;
  return { column: Boolean(row), defaultExpr: row?.column_default ?? null };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  let branch = "unknown";
  try {
    branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    blockers.push("Could not read git branch");
  }
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch ${branch} !== ${REQUIRED_BRANCH}`);

  const dryrunManifest = path.join(
    process.cwd(),
    ".cursor/audit-reports/delete-cascade-undo-v2-staging-dryrun",
    DRYRUN_RUN,
    "manifest.json",
  );
  if (!fs.existsSync(dryrunManifest)) {
    blockers.push(`Dry-run manifest missing: ${DRYRUN_RUN}`);
  } else {
    const dm = JSON.parse(fs.readFileSync(dryrunManifest, "utf8")) as { dryrun_pass?: boolean };
    if (!dm.dryrun_pass) blockers.push(`Dry-run ${DRYRUN_RUN} not PASS`);
  }

  const approval = readApproval();
  if (!approval.valid) blockers.push("Approval flags not all true — STOP");

  if (!fs.existsSync(path.join(process.cwd(), MIGRATION_FILE))) {
    blockers.push(`Migration file missing: ${MIGRATION_FILE}`);
  }

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const ref = refFromConnectionUrl(dbUrl);
  const urlRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "");
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  if (ref !== STAGING_REF && getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging guard failed (expected ${STAGING_REF}, conn ${ref ?? "null"})`);
  }
  if (dbUrl.includes(ORIGINAL_REF)) blockers.push(`BLOCKED: connection targets original ${ORIGINAL_REF}`);
  if (urlRef && urlRef !== STAGING_REF) blockers.push(`NEXT_PUBLIC_SUPABASE_URL ref ${urlRef} !== ${STAGING_REF}`);

  fs.writeFileSync(path.join(outDir, "rollback.sql"), ROLLBACK_SQL);
  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      `Path: \`${APPROVAL_PATH}\``,
      "",
      ...Object.entries(approval.flags).map(([k, v]) => `- ${k}: ${v}`),
      "",
      `Migration: \`${MIGRATION_FILE}\``,
      `Dry-run: \`${DRYRUN_RUN}\``,
    ].join("\n") + "\n",
  );

  if (blockers.length || !apply) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      (blockers.length ? blockers : ["Pass --apply to execute migration"]).map((b) => `- ${b}`).join("\n") +
        "\n",
    );
    fs.writeFileSync(
      path.join(outDir, "DELETE_CASCADE_UNDO_V2_STAGING_APPLY_EXECUTE.md"),
      [
        "# DELETE-CASCADE-UNDO-V2-STAGING-APPLY-EXECUTE",
        "",
        `Run: \`${runId}\``,
        "",
        `**${blockers.length ? "BLOCKED" : "DRY_RUN_ONLY"}** — migration not applied`,
        "",
        ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["- Add `--apply` to execute"]),
      ].join("\n") + "\n",
    );
    const manifest = {
      prompt: "DELETE-CASCADE-UNDO-V2-STAGING-APPLY-EXECUTE",
      run_id: runId,
      migration_applied: false,
      staging_ref: STAGING_REF,
      blockers: blockers.length ? blockers : ["Pass --apply"],
      status: blockers.length ? "BLOCKED" : "DRY_RUN_ONLY",
      db_mutated: false,
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest, null, 2));
    if (blockers.length) process.exit(1);
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  for (const t of V1_PARTIAL_TABLES) {
    if (await tableExists(client, t)) {
      blockers.push(`v1 partial apply suspected: table ${t} already exists`);
    }
  }

  const fullyApplied =
    (await fnExists(client, "preview_restore_undo_batch")) &&
    (await fnExists(client, "apply_restore_undo_batch")) &&
    (await tableExists(client, "audit_events"));

  let applyError: string | null = null;
  let applyMode: "executed" | "idempotent_verify_only" = "executed";

  if (fullyApplied) {
    applyMode = "idempotent_verify_only";
  } else if (!blockers.length) {
    const migrationSql = fs.readFileSync(path.join(process.cwd(), MIGRATION_FILE), "utf8");
    try {
      await client.query(migrationSql);
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
      blockers.push(`Migration apply failed: ${applyError}`);
    }
  }

  const verify: Record<string, unknown> = {
    functions: {} as Record<string, boolean>,
    tables: {} as Record<string, boolean>,
    retention: {} as Record<string, unknown>,
  };

  if (!applyError) {
    for (const fn of V2_FUNCTIONS) {
      (verify.functions as Record<string, boolean>)[fn] = await fnExists(client, fn);
      if (!(verify.functions as Record<string, boolean>)[fn]) {
        blockers.push(`Missing function after apply: ${fn}`);
      }
    }
    for (const t of V1_PARTIAL_TABLES) {
      (verify.tables as Record<string, boolean>)[t] = await tableExists(client, t);
      if (!(verify.tables as Record<string, boolean>)[t]) {
        blockers.push(`Missing table after apply: ${t}`);
      }
    }
    const ret = await retentionDefault(client);
    verify.retention = ret;
    if (!ret.column) blockers.push("Missing organization_settings.undo_snapshot_retention_days");
    else if (!ret.defaultExpr?.includes("30")) {
      blockers.push(`Retention default unexpected: ${ret.defaultExpr ?? "null"}`);
    }
    for (const tbl of ["pallets", "packages", "return_items"] as const) {
      const hasUndo = await columnExists(client, tbl, "undo_batch_id");
      const hasBy = await columnExists(client, tbl, "deleted_by");
      if (!hasUndo) blockers.push(`Missing ${tbl}.undo_batch_id`);
      if (!hasBy) blockers.push(`Missing ${tbl}.deleted_by`);
    }
  }

  await client.end();

  let regression: { ok?: boolean; stderr?: string } = {};
  if (!blockers.length) {
    try {
      execSync("npm run test:expected-receive-delete-release", {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      regression = { ok: true };
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message?: string };
      regression = { ok: false, stderr: err.stderr ?? err.message };
      blockers.push("Regression test:expected-receive-delete-release failed");
    }
  }
  verify.regression = regression;

  const pass = blockers.length === 0 && !applyError;

  fs.writeFileSync(
    path.join(outDir, "migration-apply-result.md"),
    [
      "# Migration apply result",
      "",
      `- **Migration:** \`${MIGRATION_FILE}\``,
      `- **Applied:** ${applyError ? "**FAILED**" : applyMode === "idempotent_verify_only" ? "**IDEMPOTENT**" : "**SUCCESS**"}`,
      `- **Staging ref:** \`${STAGING_REF}\``,
      applyError ? `- **Error:** \`${applyError}\`` : "",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "schema-verify.json"),
    JSON.stringify(verify, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "DELETE_CASCADE_UNDO_V2_STAGING_APPLY_EXECUTE.md"),
    [
      "# DELETE-CASCADE-UNDO-V2-STAGING-APPLY-EXECUTE",
      "",
      `Run: \`${runId}\` · Branch: \`${branch}\` · Staging: \`${STAGING_REF}\``,
      "",
      `## Result: **${pass ? "PASS" : "FAIL"}**`,
      "",
      `- Migration: \`${MIGRATION_FILE}\``,
      `- Apply mode: ${applyMode}`,
      "",
      "## Verify",
      "",
      "| Check | Status |",
      "|-------|--------|",
      `| preview_restore_undo_batch | ${(verify.functions as Record<string, boolean>)?.preview_restore_undo_batch ? "exists" : "missing"} |`,
      `| apply_restore_undo_batch | ${(verify.functions as Record<string, boolean>)?.apply_restore_undo_batch ? "exists" : "missing"} |`,
      `| retention default 30 | ${(verify.retention as { defaultExpr?: string })?.defaultExpr ?? "n/a"} |`,
      `| test:expected-receive-delete-release | ${regression.ok ? "PASS" : "FAIL/skip"} |`,
      "",
      "## Blockers",
      "",
      ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["- None"]),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    (blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "- None") + "\n",
  );

  const manifest = {
    prompt: "DELETE-CASCADE-UNDO-V2-STAGING-APPLY-EXECUTE",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    migration_file: MIGRATION_FILE,
    migration_applied: pass && applyMode === "executed",
    apply_mode: applyMode,
    verify,
    blockers,
    rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
    status: pass ? "PASS" : "FAIL",
    db_mutated: applyMode === "executed" && !applyError,
    next_prompt: pass ? "NEDA-RETURNS-UNDO-RESTORE-UI-PHASE1" : "DELETE-CASCADE-UNDO-V2-STAGING-APPLY-EXECUTE — fix blockers",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
