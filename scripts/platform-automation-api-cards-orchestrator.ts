/**
 * PLATFORM AUTOMATION API CARDS ORCHESTRATOR — reimbursements / settlement / finances (staging)
 *
 * Dry-run by default. Apply requires --apply + PLATFORM_AUTOMATION_API_CARDS_CONFIRM_APPLY=true.
 *
 *   npx tsx scripts/platform-automation-api-cards-orchestrator.ts
 *   npx tsx scripts/platform-automation-api-cards-orchestrator.ts --apply --force-due
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { apiCardSyncWindowThroughToday } from "../lib/platform-automation-api-card-window";
import { readStoreAutomationSettingsFromPg } from "../lib/platform-automation-settings-read";
import {
  evaluateAllApiCardSchedules,
  resolveSchedulerAction,
} from "../lib/platform-automation-scheduler-due";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = {
  id: "server-only",
  filename: "server-only",
  loaded: true,
  exports: {},
} as NodeModule;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = process.env.PLATFORM_AUTOMATION_ORG_ID?.trim() || "00000000-0000-0000-0000-000000000001";
const STORE_ID =
  process.env.PLATFORM_AUTOMATION_STORE_ID?.trim() || "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/platform-automation-api-cards-run";

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
  return process.env.PLATFORM_AUTOMATION_API_CARDS_CONFIRM_APPLY?.trim() === "true";
}

async function writeAuditViaPg(
  client: pg.Client,
  entries: Array<{
    automation_type: string;
    action: string;
    before_json: Record<string, unknown> | null;
    after_json: Record<string, unknown> | null;
    metadata: Record<string, unknown>;
  }>,
): Promise<void> {
  if (!entries.length) return;
  for (const e of entries) {
    await client.query(
      `INSERT INTO public.platform_automation_audit_log
         (organization_id, store_id, automation_type, action, actor_user_id, actor_email, before_json, after_json, metadata)
       VALUES ($1::uuid, $2::uuid, $3, $4, NULL, NULL, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [
        ORG_ID,
        STORE_ID,
        e.automation_type,
        e.action,
        e.before_json ? JSON.stringify(e.before_json) : null,
        e.after_json ? JSON.stringify(e.after_json) : null,
        JSON.stringify(e.metadata),
      ],
    );
  }
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
  if (!supabaseUrlMatchesStagingRef(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", STAGING_REF)) {
    blockers.push("NEXT_PUBLIC_SUPABASE_URL must target staging");
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl.includes(STAGING_REF)) blockers.push("STAGING_DIRECT_POSTGRES_URL must target staging");

  if (apply && !confirmApplyOk()) {
    blockers.push("PLATFORM_AUTOMATION_API_CARDS_CONFIRM_APPLY must be true for --apply");
  }

  if (blockers.length) {
    const manifest = { run_id: runId, blockers, safe_to_continue: false };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest, null, 2));
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const storeSettings = await readStoreAutomationSettingsFromPg(client, ORG_ID, STORE_ID);
  const now = new Date();
  const evals = evaluateAllApiCardSchedules(storeSettings, now);

  if (forceDue) {
    for (const key of ["reimbursements_api", "settlement_api", "finances_archive_api"] as const) {
      evals[key].schedule.due = true;
      evals[key].schedule.reason = "force_due_test";
    }
  }

  const dryRun = !apply || !confirmApplyOk();
  const { runScheduledApiCard } = await import("../lib/platform-automation-api-card-scheduled-run");

  const cardResults: Record<string, unknown> = {};

  for (const card of ["reimbursements_api", "settlement_api", "finances_archive_api"] as const) {
    const evaluation = evals[card];
    const schedule = storeSettings[card];
    const gate = {
      enabled: evaluation.enabled,
      due: evaluation.schedule.due,
      reason: evaluation.schedule.reason,
      next_run_at: evaluation.schedule.next_run_at,
      rolling_days: evaluation.rolling_days,
      run_hours_utc: evaluation.schedule.run_hours_utc,
      settings_source: evaluation.settings_source,
      scope: { organization_id: ORG_ID, store_id: STORE_ID },
    };

    await writeAuditViaPg(client, [
      {
        automation_type: card,
        action: "cron_tick",
        before_json: gate,
        after_json: { skipped: !evaluation.enabled || !evaluation.schedule.due, dry_run: dryRun },
        metadata: { source: "platform_automation_api_cards_orchestrator", run_id: runId },
      },
    ]);

    const action = resolveSchedulerAction({
      enabled: evaluation.enabled,
      due: evaluation.schedule.due,
      applyRequested: apply,
      confirmApply: confirmApplyOk(),
    });

    if (action.action === "noop") {
      cardResults[card] = { action, gate, skipped: true };
      continue;
    }

    const result = await runScheduledApiCard({
      connectionString: dbUrl,
      organizationId: ORG_ID,
      storeId: STORE_ID,
      evaluation,
      schedule,
      dryRun,
    });

    await writeAuditViaPg(client, [
      {
        automation_type: card,
        action: "cron_run",
        before_json: gate,
        after_json: result as unknown as Record<string, unknown>,
        metadata: { source: "platform_automation_api_cards_orchestrator", run_id: runId, dry_run: dryRun },
      },
    ]);

    cardResults[card] = { action, gate, result, preview_window: apiCardSyncWindowThroughToday(schedule.rolling_days) };
  }

  await client.end();

  const manifest = {
    prompt: "PHASE-4C-SCHEDULED-EXECUTOR-WIRE-STAGING",
    run_id: runId,
    staging_ref: STAGING_REF,
    organization_id: ORG_ID,
    store_id: STORE_ID,
    settings_read_path: "platform_settings.automation_settings.scopes[org:store]",
    store_settings_snapshot: {
      reimbursements_enabled: storeSettings.reimbursements_api.enabled,
      settlement_enabled: storeSettings.settlement_api.enabled,
      finances_enabled: storeSettings.finances_archive_api.enabled,
    },
    evaluations: evals,
    card_results: cardResults,
    apply_requested: apply,
    confirm_apply: confirmApplyOk(),
    force_due: forceDue,
    dry_run: dryRun,
    safe_to_continue: true,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, outDir, dry_run: dryRun, card_results: cardResults }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
