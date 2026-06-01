/**
 * PLATFORM AUTOMATION SCHEDULER TICK — product enrichment + removal schedule evaluation.
 * Dry-run by default; no cron enable; no apply unless --apply + confirm gate.
 *
 *   npx tsx scripts/platform-automation-scheduler-tick.ts
 *   npx tsx scripts/platform-automation-scheduler-tick.ts --apply --force-due
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";

import { readPlatformAutomationSettingsFromPg } from "../lib/platform-automation-settings-read";
import {
  evaluateProductEnrichmentSchedule,
  evaluateRemovalAutomationSchedule,
  resolveSchedulerAction,
} from "../lib/platform-automation-scheduler-due";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/platform-automation-scheduler-tick";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(f: string): boolean {
  return process.argv.includes(f);
}

function confirmApplyOk(): boolean {
  return process.env.PLATFORM_AUTOMATION_CONFIRM_APPLY?.trim() === "true";
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = hasFlag("--apply");
  const forceDue = hasFlag("--force-due");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const blockers: string[] = [];
  const urlRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (urlRef === ORIGINAL_REF) blockers.push("original ref forbidden");
  if (urlRef !== STAGING_REF) blockers.push(`staging ref required (got ${urlRef ?? "missing"})`);
  if (process.env.REMOVAL_AUTOMATION_APPLY_ENABLED?.trim() === "true") {
    blockers.push("REMOVAL_AUTOMATION_APPLY_ENABLED must stay off");
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");

  let settings = null as Awaited<ReturnType<typeof readPlatformAutomationSettingsFromPg>> | null;
  if (dbUrl && !blockers.length) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    settings = await readPlatformAutomationSettingsFromPg(client);
    await client.end();
  }

  const now = new Date();
  const peEval = settings
    ? evaluateProductEnrichmentSchedule(settings.product_enrichment, now)
    : null;
  const remEval = settings ? evaluateRemovalAutomationSchedule(settings.removal_api_sync, now) : null;

  if (forceDue && peEval) {
    peEval.schedule.due = true;
    peEval.schedule.reason = "force_due_test";
  }
  if (forceDue && remEval) {
    remEval.recent.due = true;
    remEval.recent.reason = "force_due_test";
  }

  const peAction = peEval
    ? resolveSchedulerAction({
        enabled: peEval.schedule.enabled,
        due: peEval.schedule.due,
        applyRequested: apply,
        confirmApply: confirmApplyOk(),
      })
    : { action: "noop" as const, reason: "no_settings" };

  const remAction = remEval
    ? resolveSchedulerAction({
        enabled: remEval.enabled,
        due: remEval.recent.due,
        applyRequested: apply,
        confirmApply: confirmApplyOk(),
      })
    : { action: "noop" as const, reason: "no_settings" };

  const enrichmentLog: Record<string, unknown> = {
    action: peAction.action,
    reason: peAction.reason,
    evaluation: peEval,
  };

  if (peAction.action === "apply" && settings?.product_enrichment.enabled) {
    enrichmentLog.would_enqueue = {
      job_type: "product_enrichment",
      organization_id: ORG_ID,
      store_id: STORE_ID,
      note: "Apply path requires async job approval + tick loop — not invoked in wiring dry-run unless extended",
    };
  } else if (peAction.action === "dry_run_log") {
    enrichmentLog.dry_run = {
      message: "Would enqueue product_enrichment background job",
      job_type: "product_enrichment",
      organization_id: ORG_ID,
      store_id: STORE_ID,
    };
  }

  let removalOrchestrator: Record<string, unknown> = { action: remAction.action, reason: remAction.reason };
  if (remAction.action === "dry_run_log" || remAction.action === "apply") {
    const orchArgs = [
      "tsx",
      "scripts/removal-automation-orchestrator.ts",
      `--run-id=${runId}-removal`,
      "--from-scheduler",
    ];
    if (apply && confirmApplyOk()) orchArgs.push("--apply");
    if (forceDue) orchArgs.push("--force-schedule");
    const res = spawnSync("npx", orchArgs, {
      cwd: process.cwd(),
      env: process.env,
      shell: true,
      encoding: "utf8",
    });
    removalOrchestrator = {
      ...removalOrchestrator,
      orchestrator_exit: res.status,
      stdout: res.stdout?.slice(-2000) ?? "",
      stderr: res.stderr?.slice(-2000) ?? "",
    };
  }

  const historicalNote = remEval
    ? {
        window_keys: remEval.historical.window_keys,
        due: remEval.historical.due,
        auto_apply: false,
        note: "Historical backfill window_keys honored in evaluation only — never auto-applied",
      }
    : null;

  const manifest = {
    prompt: "AUTOMATION-SETTINGS-ORCHESTRATOR-WIRING-DRYRUN",
    run_id: runId,
    staging_ref: STAGING_REF,
    settings_read_path: "public.platform_settings.automation_settings",
    settings,
    product_enrichment: enrichmentLog,
    removal_api_sync: {
      evaluation: remEval,
      orchestrator: removalOrchestrator,
      historical_backfill: historicalNote,
    },
    apply_requested: apply,
    confirm_apply: confirmApplyOk(),
    force_due: forceDue,
    blockers,
    safe_to_continue: blockers.length === 0,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: blockers.length === 0, outDir, manifest }, null, 2));
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
