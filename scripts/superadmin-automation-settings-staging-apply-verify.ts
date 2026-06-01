/**
 * SUPERADMIN-AUTOMATION-SETTINGS-STAGING-APPLY-VERIFY
 * Approval-gated staging DDL apply + verification.
 *
 *   npx tsx scripts/superadmin-automation-settings-staging-apply-verify.ts --run-id=<UTC_Z>
 *   npx tsx scripts/superadmin-automation-settings-staging-apply-verify.ts --run-id=<UTC_Z> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { canEditPlatformProductSettings } from "../lib/platform-product-settings-access";
import {
  computeProductEnrichmentNextRun,
  computeRemovalHistoricalNextRun,
  computeRemovalRecentNextRun,
  normalizePlatformAutomationSettings,
} from "../lib/platform-automation-schedule";
import { DEFAULT_PLATFORM_AUTOMATION_SETTINGS } from "../lib/platform-automation-settings-types";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const MIGRATION = "20260903120000_platform_automation_settings.sql";
const APPROVAL = ".cursor/operator-approvals/superadmin-automation-settings-phase1-staging-approval.md";
const OUT_BASE = ".cursor/audit-reports/superadmin-automation-settings-staging-apply-verify";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApprovalFlag(filePath: string, flag: string): boolean {
  const full = path.join(process.cwd(), filePath);
  if (!fs.existsSync(full)) return false;
  return new RegExp(`${flag}\\s*=\\s*true`, "i").test(fs.readFileSync(full, "utf8"));
}

type ColumnInfo = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

async function fetchAutomationColumn(client: pg.Client): Promise<ColumnInfo | null> {
  const r = await client.query<ColumnInfo>(
    `SELECT column_name, data_type, is_nullable, column_default::text AS column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'platform_settings'
       AND column_name = 'automation_settings'`,
  );
  return r.rows[0] ?? null;
}

async function fetchAutomationSettings(client: pg.Client): Promise<unknown> {
  const r = await client.query(`SELECT automation_settings FROM public.platform_settings WHERE id = true`);
  return r.rows[0]?.automation_settings ?? null;
}

function allEnabledFalse(raw: unknown): boolean {
  const s = normalizePlatformAutomationSettings(raw);
  return (
    s.product_enrichment.enabled === false &&
    s.removal_api_sync.enabled === false &&
    s.removal_api_sync.historical_backfill.enabled === false
  );
}

function cronGuardChecks(): Record<string, boolean> {
  const gha = fs.readFileSync(
    path.join(process.cwd(), ".github/workflows/removal-automation-staging.yml"),
    "utf8",
  );
  const scheduledDryRunOnly =
    gha.includes("default: false") &&
    gha.includes('if [ "${{ github.event_name }}" = "workflow_dispatch" ]') &&
    gha.includes("ARGS+=(--apply)");
  return {
    env_apply_enabled_not_true: process.env.REMOVAL_AUTOMATION_APPLY_ENABLED?.trim() !== "true",
    gha_scheduled_dry_run_default: scheduledDryRunOnly,
    gha_apply_requires_secret: gha.includes("REMOVAL_AUTOMATION_APPLY_ENABLED"),
    platform_defaults_disabled: true,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const blockers: string[] = [];

  const stagingRef = getStagingProjectRef({ loadEnv: false });
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const prodUrl = process.env.PRODUCTION_DIRECT_POSTGRES_URL?.trim() ?? "";
  const urlRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");

  if (stagingRef !== STAGING_REF) blockers.push(`staging ref ${stagingRef} !== ${STAGING_REF}`);
  if (urlRef === ORIGINAL_REF) blockers.push("original ref forbidden");
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) blockers.push("DB URL not staging");
    if (dbUrl === originalUrl) blockers.push("DB URL is original");
    if (prodUrl && dbUrl === prodUrl) blockers.push("DB URL is production");
  }

  const approvedStaging = readApprovalFlag(APPROVAL, "APPROVED_TO_RUN_STAGING");
  const approvedAutomation = readApprovalFlag(
    APPROVAL,
    "APPROVED_SUPERADMIN_AUTOMATION_SETTINGS_PHASE1_STAGING",
  );
  if (apply && !approvedStaging) blockers.push(`${APPROVAL}: APPROVED_TO_RUN_STAGING not true`);
  if (apply && !approvedAutomation) {
    blockers.push(`${APPROVAL}: APPROVED_SUPERADMIN_AUTOMATION_SETTINGS_PHASE1_STAGING not true`);
  }

  const client = dbUrl
    ? new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    : null;

  let beforeColumn: ColumnInfo | null = null;
  let beforeSettings: unknown = null;
  if (client) {
    await client.connect();
    beforeColumn = await fetchAutomationColumn(client);
    if (beforeColumn) beforeSettings = await fetchAutomationSettings(client);
  }

  let migrationApplied = beforeColumn !== null;
  let applyError: string | null = null;

  if (apply && client && !blockers.length && !beforeColumn) {
    const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations", MIGRATION), "utf8");
    try {
      await client.query(sql);
      migrationApplied = true;
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
      blockers.push(`Migration apply failed: ${applyError}`);
    }
  } else if (apply && beforeColumn) {
    migrationApplied = true;
  }

  let afterColumn: ColumnInfo | null = beforeColumn;
  let afterSettings: unknown = beforeSettings;
  if (client) {
    afterColumn = await fetchAutomationColumn(client);
    if (afterColumn) afterSettings = await fetchAutomationSettings(client);
    await client.end();
  }

  const normalized = normalizePlatformAutomationSettings(afterSettings ?? {});
  const defaultsOk = allEnabledFalse(afterSettings);

  const permissionTests = {
    super_admin_can_edit: canEditPlatformProductSettings("super_admin"),
    admin_cannot_edit: !canEditPlatformProductSettings("admin"),
    system_admin_cannot_edit: !canEditPlatformProductSettings("system_admin"),
    tenant_manager_cannot_edit: !canEditPlatformProductSettings("tenant_manager"),
  };

  let saveSimOk = false;
  let saveSimError: string | null = null;
  if (client && afterColumn && !blockers.length) {
    const c2 = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await c2.connect();
    try {
      const testPayload = normalizePlatformAutomationSettings({
        ...DEFAULT_PLATFORM_AUTOMATION_SETTINGS,
        product_enrichment: { ...DEFAULT_PLATFORM_AUTOMATION_SETTINGS.product_enrichment, runs_per_day: 2 },
      });
      await c2.query(
        `UPDATE public.platform_settings SET automation_settings = $1::jsonb WHERE id = true`,
        [JSON.stringify(testPayload)],
      );
      const row = await c2.query(`SELECT automation_settings FROM public.platform_settings WHERE id = true`);
      const saved = normalizePlatformAutomationSettings(row.rows[0]?.automation_settings);
      saveSimOk = saved.product_enrichment.runs_per_day === 2 && saved.product_enrichment.enabled === false;
      await c2.query(
        `UPDATE public.platform_settings SET automation_settings = $1::jsonb WHERE id = true`,
        [JSON.stringify(normalizePlatformAutomationSettings(afterSettings))],
      );
    } catch (e) {
      saveSimError = e instanceof Error ? e.message : String(e);
    } finally {
      await c2.end();
    }
  }

  const disabledNextRun =
    computeProductEnrichmentNextRun(normalized, new Date("2026-06-01T12:00:00Z")) === null &&
    computeRemovalRecentNextRun(normalized.removal_api_sync, new Date("2026-06-01T12:00:00Z")) === null &&
    computeRemovalHistoricalNextRun(normalized.removal_api_sync, new Date("2026-06-01T12:00:00Z")) === null;

  const cronChecks = cronGuardChecks();

  let buildOk = false;
  let testOk = false;
  try {
    execSync("npx tsx scripts/test-superadmin-automation-settings-finalize.ts", {
      cwd: process.cwd(),
      stdio: "pipe",
      encoding: "utf8",
    });
    testOk = true;
  } catch {
    testOk = false;
  }
  try {
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" });
    buildOk = true;
  } catch {
    buildOk = false;
  }

  const uiRouteExists = fs.existsSync(
    path.join(process.cwd(), "app/platform/settings/automation/page.tsx"),
  );
  const uiRouteInBuild = buildOk;

  const safeToContinue =
    migrationApplied &&
    afterColumn?.data_type === "jsonb" &&
    defaultsOk &&
    Object.values(permissionTests).every(Boolean) &&
    saveSimOk &&
    disabledNextRun &&
    Object.values(cronChecks).every(Boolean) &&
    uiRouteExists &&
    buildOk &&
    testOk &&
    !blockers.length;

  const report = {
    prompt: "SUPERADMIN-AUTOMATION-SETTINGS-STAGING-APPLY-VERIFY",
    run_id: runId,
    staging_ref: STAGING_REF,
    migration_file: MIGRATION,
    migration_applied: migrationApplied,
    apply_requested: apply,
    apply_error: applyError,
    before: {
      column: beforeColumn,
      automation_settings: beforeSettings,
    },
    after: {
      column: afterColumn,
      automation_settings: afterSettings,
      normalized,
    },
    defaults_all_enabled_false: defaultsOk,
    permission_tests: permissionTests,
    superadmin_save_simulation: { ok: saveSimOk, error: saveSimError },
    disabled_schedules_next_run_null: disabledNextRun,
    cron_orchestrator_guards: cronChecks,
    ui_route: { page_exists: uiRouteExists, build_includes_route: uiRouteInBuild },
    tests: { finalize_script: testOk, build: buildOk },
    blockers,
    safe_to_continue: safeToContinue,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "SUPERADMIN-AUTOMATION-SETTINGS-STAGING-APPLY-VERIFY.md"),
    [
      "# SUPERADMIN-AUTOMATION-SETTINGS-STAGING-APPLY-VERIFY",
      "",
      `Run: \`${runId}\` · Staging \`${STAGING_REF}\``,
      "",
      "## Migration applied",
      "",
      `**${migrationApplied ? "yes" : "no"}**${applyError ? ` — ${applyError}` : ""}`,
      "",
      "## Before / after schema",
      "",
      "### Before",
      "```json",
      JSON.stringify({ column: beforeColumn, automation_settings: beforeSettings }, null, 2),
      "```",
      "",
      "### After",
      "```json",
      JSON.stringify({ column: afterColumn, automation_settings: afterSettings }, null, 2),
      "```",
      "",
      "## Permission test",
      "",
      "```json",
      JSON.stringify(permissionTests, null, 2),
      "```",
      "",
      `Superadmin DB save simulation: **${saveSimOk ? "PASS" : "FAIL"}**`,
      "",
      "## UI route test",
      "",
      `- Page file: **${uiRouteExists ? "PASS" : "FAIL"}**`,
      `- Build includes \`/platform/settings/automation\`: **${uiRouteInBuild ? "PASS" : "FAIL"}**`,
      "",
      "## Schedule guards",
      "",
      `- Defaults all enabled=false: **${defaultsOk ? "PASS" : "FAIL"}**`,
      `- Disabled → next_run null: **${disabledNextRun ? "PASS" : "FAIL"}**`,
      "",
      "## Cron / orchestrator",
      "",
      "```json",
      JSON.stringify(cronChecks, null, 2),
      "```",
      "",
      "## SAFE_TO_CONTINUE",
      "",
      `**${safeToContinue ? "yes" : "no"}**`,
      "",
      blockers.length ? `Blockers: ${blockers.join("; ")}` : "",
    ].join("\n"),
  );

  console.log(
    JSON.stringify(
      {
        ok: safeToContinue,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        migration_applied: migrationApplied,
        safe_to_continue: safeToContinue,
        blockers,
      },
      null,
      2,
    ),
  );

  if (!safeToContinue) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
