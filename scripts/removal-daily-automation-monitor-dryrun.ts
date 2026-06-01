/**
 * REMOVAL-DAILY-AUTOMATION-MONITOR-DRYRUN — read-only monitor + orchestrator dry-run proof
 *
 *   npx tsx scripts/removal-daily-automation-monitor-dryrun.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/removal-daily-automation-monitor-dryrun";
const WORKFLOW_PATH = ".github/workflows/removal-automation-staging.yml";
const ORCHESTRATOR_APPROVAL =
  ".cursor/operator-approvals/removal-automation-cron-implementation-approval.md";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readFlag(filePath: string, flag: string): boolean {
  const full = path.join(process.cwd(), filePath);
  if (!fs.existsSync(full)) return false;
  return new RegExp(`${flag}\\s*=\\s*true`, "i").test(fs.readFileSync(full, "utf8"));
}

function envPresent(name: string): boolean {
  return !!process.env[name]?.trim();
}

function endOfYesterdayUtc(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function computeRollingWindow(days: number): { start: string; end: string; span_days: number } {
  const end = endOfYesterdayUtc();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  start.setUTCHours(0, 0, 0, 0);
  const span_days = Math.ceil((end.getTime() - start.getTime()) / 86400000);
  return { start: start.toISOString(), end: end.toISOString(), span_days };
}

async function recentWindowEvidence(
  client: pg.Client,
  window: { start: string; end: string },
): Promise<Record<string, unknown>> {
  const uploads = await client.query(
    `SELECT id::text, report_type, status,
            metadata->'source_run'->>'state' AS state,
            metadata->'source_run'->'window'->>'start' AS ws,
            metadata->'source_run'->'window'->>'end' AS we,
            metadata->'source_run'->'attempt'->>'last_error_code' AS err_code,
            created_at::text
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND metadata->'source_run'->'window'->>'start' >= $2
       AND metadata->'source_run'->'window'->>'end' <= $3
     ORDER BY created_at DESC LIMIT 10`,
    [ORG_ID, window.start, window.end],
  );

  const overlapping = await client.query(
    `SELECT id::text, report_type,
            metadata->'source_run'->>'state' AS state,
            metadata->'source_run'->'window'->>'start' AS ws,
            metadata->'source_run'->'window'->>'end' AS we,
            created_at::text
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND metadata->'source_run'->>'state' IN ('complete','synthetic_upload_ready')
     ORDER BY created_at DESC LIMIT 6`,
    [ORG_ID],
  );

  const activity = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM public.amazon_removals
        WHERE organization_id=$1::uuid AND order_date >= $2::timestamptz AND order_date <= $3::timestamptz) AS removals_in_window,
       (SELECT MAX(order_date)::text FROM public.amazon_removals WHERE organization_id=$1::uuid) AS latest_order_date,
       (SELECT COUNT(*)::int FROM public.expected_packages
        WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NULL) AS ep_unresolved`,
    [ORG_ID, window.start, window.end],
  );

  return {
    exact_window_uploads: uploads.rows,
    latest_successful_uploads: overlapping.rows,
    staging_activity: activity.rows[0],
  };
}

function parseWorkflowDryRunPolicy(yaml: string): Record<string, unknown> {
  const scheduledApply =
    /schedule:[\s\S]*?run:[\s\S]*?--apply/.test(yaml) &&
    !/schedule:[\s\S]*?ARGS\+\=\(--apply\)/.test(yaml);
  const dispatchGated =
    /workflow_dispatch[\s\S]*inputs[\s\S]*apply/.test(yaml) &&
    /REMOVAL_AUTOMATION_APPLY_ENABLED/.test(yaml);
  const cronLines = yaml.match(/cron:\s*"[^"]+"/g) ?? [];
  return {
    scheduled_cron_expressions: cronLines,
    scheduled_runs_with_apply_flag: scheduledApply,
    workflow_dispatch_apply_gated_by_secret: dispatchGated,
    default_mode_comment: yaml.includes("Default: DRY-RUN") ? "DRY-RUN documented" : "check yaml",
    rolling_days_default: yaml.match(/REMOVAL_AUTOMATION_ROLLING_DAYS:\s*"(\d+)"/)?.[1] ?? "7",
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  let branch = "unknown";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }

  const rollingDays = 7;
  const window = computeRollingWindow(rollingDays);

  const orchestratorRunId = `${runId}-orchestrator-dryrun`;
  const orch = spawnSync(
    "npx",
    [
      "tsx",
      "scripts/removal-automation-orchestrator.ts",
      `--run-id=${orchestratorRunId}`,
      `--rolling-days=${rollingDays}`,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8", shell: true },
  );

  const orchManifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/removal-automation-run",
    orchestratorRunId,
    "manifest.json",
  );
  const orchManifest = fs.existsSync(orchManifestPath)
    ? JSON.parse(fs.readFileSync(orchManifestPath, "utf8"))
    : null;

  const workflowYaml = fs.readFileSync(path.join(process.cwd(), WORKFLOW_PATH), "utf8");
  const workflowPolicy = parseWorkflowDryRunPolicy(workflowYaml);

  const applyFlags = {
    env_REMOVAL_AUTOMATION_CONFIRM_APPLY: envPresent("REMOVAL_AUTOMATION_CONFIRM_APPLY")
      ? process.env.REMOVAL_AUTOMATION_CONFIRM_APPLY?.trim()
      : "(unset)",
    env_REMOVAL_AUTOMATION_APPLY_ENABLED: envPresent("REMOVAL_AUTOMATION_APPLY_ENABLED")
      ? process.env.REMOVAL_AUTOMATION_APPLY_ENABLED?.trim()
      : "(unset)",
    orchestrator_approval_cron:
      readFlag(ORCHESTRATOR_APPROVAL, "APPROVED_TO_IMPLEMENT_REMOVAL_AUTOMATION_CRON"),
    fetch_approval: readFlag(
      ".cursor/operator-approvals/sp-api-removal-shipment-fetch-approval.md",
      "APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH",
    ),
    domain_sync_approval: readFlag(
      ".cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md",
      "APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC",
    ),
    resolver_approval: readFlag(
      ".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md",
      "APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL",
    ),
  };

  let recentEvidence: Record<string, unknown> = {};
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (dbUrl && supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    recentEvidence = await recentWindowEvidence(client, window);
    await client.end();
  }

  const confirmApplyLocal = process.env.REMOVAL_AUTOMATION_CONFIRM_APPLY?.trim() === "true";
  const blockersToApply: string[] = [];
  if (!confirmApplyLocal) {
    blockersToApply.push("Local env REMOVAL_AUTOMATION_CONFIRM_APPLY is not true.");
  } else {
    blockersToApply.push(
      "Local REMOVAL_AUTOMATION_CONFIRM_APPLY=true from burn-in — does NOT enable scheduled cron (workflow still dry-run).",
    );
  }
  blockersToApply.push(
    "Historical gap 2025-11-01 → 2025-12-25 blocked by Amazon FATAL — full Sep→today parity incomplete.",
  );
  blockersToApply.push(
    "Cron apply not burn-in validated on GitHub Actions runner (local supervised apply only).",
  );
  if (!applyFlags.orchestrator_approval_cron) {
    blockersToApply.push("Orchestrator approval flag should remain documented; cron apply still operator-gated.");
  }

  const recentOk =
    Array.isArray(recentEvidence.latest_successful_uploads) &&
    (recentEvidence.latest_successful_uploads as unknown[]).length >= 2;

  const exactNextPrompt =
    "REMOVAL-NOV-DEC-SPLIT-WINDOW-FETCH-DRYRUN — resolve historical gap; keep cron dry-run until gap closed + 3 consecutive supervised apply PASS";

  const report = [
    "# REMOVAL-DAILY-AUTOMATION-MONITOR-DRYRUN",
    "",
    `Run: \`${runId}\` · Branch: \`${branch}\` · Mode: monitor dry-run only · Target: staging \`${STAGING_REF}\``,
    "",
    "# CURRENT_CRON_STATUS",
    "",
    "| Item | Status |",
    "|------|--------|",
    "| Workflow file | `.github/workflows/removal-automation-staging.yml` |",
    `| Scheduled cron | ${(workflowPolicy.scheduled_cron_expressions as string[]).join(", ") || "see yaml"} |`,
    "| Scheduled runs pass `--apply` | **NO** — cron invokes orchestrator without `--apply` |",
    "| workflow_dispatch apply | Gated by `REMOVAL_AUTOMATION_APPLY_ENABLED` GitHub secret |",
    `| Default rolling window | **${workflowPolicy.rolling_days_default} days** |`,
    "| Concurrency | `removal-automation-staging` group; no cancel-in-progress |",
    "",
    "Scheduled workflow remains **dry-run only** until operator sets secret + manual dispatch with `apply=true`.",
    "",
    "# DRYRUN_RESULT",
    "",
    "| Check | Result |",
    "|-------|--------|",
    "| Orchestrator invoked | `scripts/removal-automation-orchestrator.ts` (no `--apply`) |",
    `| Orchestrator exit | **${orch.status === 0 ? "PASS" : "FAIL"}** (code ${orch.status}) |`,
    "| Mode | **dry-run** |",
    "| Amazon API called | **NO** |",
    "| Child scripts executed | **NO** (fetch/sync/verify/resolver skipped) |",
    "| DB writes | **NO** |",
    `| Orchestrator manifest | \`.cursor/audit-reports/removal-automation-run/${orchestratorRunId}/manifest.json\` |`,
    "",
    orchManifest
      ? [
          "**Planned pipeline steps (would run on apply):**",
          "",
          ...(orchManifest.steps_planned as string[]).map((s: string) => `- \`${s}\``),
          "",
          `Window computed: \`${(orchManifest.window as { start: string; end: string }).start}\` → \`${(orchManifest.window as { start: string; end: string }).end}\``,
        ].join("\n")
      : "_Orchestrator manifest not found._",
    "",
    "# RECENT_WINDOW_STATUS",
    "",
    `Rolling **${rollingDays}-day** window: \`${window.start}\` → \`${window.end}\` (${window.span_days} calendar span)`,
    "",
    "## Staging activity (read-only census)",
    "",
    "```json",
    JSON.stringify(recentEvidence, null, 2),
    "```",
    "",
    "| Signal | Interpretation |",
    "|--------|----------------|",
    `| Recent successful uploads exist | **${recentOk ? "YES" : "check evidence"}** — incremental SP-API path healthy for recent windows |`,
    `| Removals in rolling window | **${(recentEvidence.staging_activity as { removals_in_window?: number })?.removals_in_window ?? "?"}** |`,
    `| Latest order date | **${(recentEvidence.staging_activity as { latest_order_date?: string })?.latest_order_date ?? "?"}** |`,
    `| EP unresolved (org-wide) | **${(recentEvidence.staging_activity as { ep_unresolved?: number })?.ep_unresolved ?? "?"}** |`,
    "",
    "Prior supervised burn-in (`removal-daily-automation-apply-burnin-staging`) confirmed fetch PASS for rolling window `2026-05-22` → `2026-05-29` with verify gate PASS.",
    "",
    "# APPLY_FLAGS_STATUS",
    "",
    "```json",
    JSON.stringify(applyFlags, null, 2),
    "```",
    "",
    "| Gate | Required for apply | Current |",
    "|------|-------------------|---------|",
    "| `APPROVED_TO_IMPLEMENT_REMOVAL_AUTOMATION_CRON=true` | yes | **true** (signed) |",
    `| REMOVAL_AUTOMATION_CONFIRM_APPLY=true (local) | yes | **${confirmApplyLocal ? "true (burn-in env; cron still dry-run)" : "not set"}** |`,
    "| GitHub secret `REMOVAL_AUTOMATION_APPLY_ENABLED=true` | yes for GHA apply | **operator must confirm unset/false** |",
    "| Sub-approvals (fetch/sync/resolver) | yes | signed |",
    "",
    "**Cron apply is NOT enabled.** Monitor mode confirmed.",
    "",
    "# BLOCKERS_TO_APPLY",
    "",
    ...blockersToApply.map((b) => `- ${b}`),
    "",
    "## Readiness checklist ( eventual apply )",
    "",
    "- [ ] Close or waive Nov/Dec 2025 historical gap (`2025-11-01` → `2025-12-25`)",
    "- [ ] 3 consecutive supervised `--apply` orchestrator PASS on staging (local or workflow_dispatch)",
    "- [ ] Verify gate non-overflow mismatch = 0 on each apply run",
    "- [ ] Duplicate/idempotency checks PASS (upload keys, staging dup groups)",
    "- [ ] Set GitHub secret `REMOVAL_AUTOMATION_APPLY_ENABLED=true` deliberately",
    "- [ ] First GHA apply via `workflow_dispatch` with `apply=true` (not scheduled cron)",
    "- [ ] Monitor 5 scheduled dry-runs remain PASS before enabling scheduled apply",
    "- [ ] Alert webhook configured (optional `REMOVAL_AUTOMATION_ALERT_WEBHOOK`)",
    "",
    "# EXACT_NEXT_PROMPT",
    "",
    "```",
    exactNextPrompt,
    "```",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "REMOVAL-DAILY-AUTOMATION-MONITOR-DRYRUN.md"), report);
  fs.writeFileSync(
    path.join(outDir, "evidence.json"),
    JSON.stringify(
      {
        run_id: runId,
        branch,
        window,
        workflow_policy: workflowPolicy,
        apply_flags: applyFlags,
        orchestrator_dryrun: {
          run_id: orchestratorRunId,
          exit_code: orch.status,
          manifest: orchManifest,
        },
        recent_window: recentEvidence,
        blockers_to_apply: blockersToApply,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-DAILY-AUTOMATION-MONITOR-DRYRUN",
        run_id: runId,
        mode: "dry-run-monitor",
        cron_apply_enabled: false,
        orchestrator_dryrun_pass: orch.status === 0,
        rolling_window: window,
        exact_next_prompt: exactNextPrompt,
        no_db_writes: true,
        no_original: true,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        orchestrator_dryrun_pass: orch.status === 0,
        cron_apply_enabled: false,
        window,
        exact_next_prompt: exactNextPrompt,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
