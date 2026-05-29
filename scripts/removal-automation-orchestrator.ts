/**
 * REMOVAL DAILY AUTOMATION ORCHESTRATOR — twice-daily staging pipeline (dry-run default)
 *
 * Pipeline (apply):
 *   1. fetch reports → raw_report_uploads + storage archive
 *   2. domain sync (normalize/staging → amazon_* domain tables)
 *   3. grouped rebuild → rebuild_expected_packages_from_removals
 *   4. verify allocation (mismatch must be 0)
 *   5. resolver reconcile (map-only)
 *   6. audit manifest + artifacts under removal-automation-run/<run_id>/
 *
 *   npx tsx scripts/removal-automation-orchestrator.ts
 *   npx tsx scripts/removal-automation-orchestrator.ts --apply
 *   npx tsx scripts/removal-automation-orchestrator.ts --manual --apply --run-id=<UTC_Z>
 *
 * Apply requires:
 *   - APPROVED_TO_IMPLEMENT_REMOVAL_AUTOMATION_CRON=true (approval file)
 *   - REMOVAL_AUTOMATION_CONFIRM_APPLY=true (env / GitHub secret gate)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const ORCHESTRATOR_APPROVAL =
  ".cursor/operator-approvals/removal-automation-cron-implementation-approval.md";

const ORG_ID = process.env.REMOVAL_AUTOMATION_ORG_ID?.trim() || "00000000-0000-0000-0000-000000000001";
const STORE_ID =
  process.env.REMOVAL_AUTOMATION_STORE_ID?.trim() || "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const OUT_BASE_RUN = ".cursor/audit-reports/removal-automation-run";
const WINDOW_CURSOR_PATH = path.join(OUT_BASE_RUN, ".window-cursor.json");
const RUN_LOCK_PATH = path.join(OUT_BASE_RUN, ".run-lock.json");

/** Twice-daily incremental default; override with REMOVAL_AUTOMATION_ROLLING_DAYS or --rolling-days= */
const DEFAULT_ROLLING_DAYS = 7;

const SUB_APPROVALS = [
  {
    step: "fetch",
    path: ".cursor/operator-approvals/sp-api-removal-shipment-fetch-approval.md",
    flags: ["APPROVED_TO_RUN_STAGING", "APPROVED_SP_API_REMOVAL_SHIPMENT_FETCH"],
  },
  {
    step: "domain_sync",
    path: ".cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md",
    flags: ["APPROVED_TO_RUN_STAGING", "APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC"],
  },
  {
    step: "resolver",
    path: ".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md",
    flags: ["APPROVED_TO_RUN_STAGING", "APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL"],
  },
] as const;

type StepId = "fetch" | "domain_sync" | "verify" | "resolver";

type PlannedStep = {
  id: StepId;
  pipeline_phase: string;
  script: string;
  description: string;
  dry_run_note: string;
  apply_argv: string[];
  child_out_base: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function argValue(prefix: string): string | null {
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.split("=")[1]!.trim() : null;
}

function rollingDays(): number {
  const arg = argValue("--rolling-days=");
  if (arg) {
    const n = Number(arg);
    if (Number.isFinite(n) && n >= 1 && n <= 90) return Math.floor(n);
  }
  const env = Number(process.env.REMOVAL_AUTOMATION_ROLLING_DAYS ?? DEFAULT_ROLLING_DAYS);
  return Number.isFinite(env) && env >= 1 ? Math.min(90, Math.floor(env)) : DEFAULT_ROLLING_DAYS;
}

function readFlagFromFile(filePath: string, flag: string): boolean {
  const full = path.join(process.cwd(), filePath);
  if (!fs.existsSync(full)) return false;
  const text = fs.readFileSync(full, "utf8");
  return new RegExp(`${flag}\\s*=\\s*true`, "i").test(text);
}

function readOrchestratorApproval(): { valid: boolean; raw: Record<string, string> } {
  const cron = readFlagFromFile(
    ORCHESTRATOR_APPROVAL,
    "APPROVED_TO_IMPLEMENT_REMOVAL_AUTOMATION_CRON",
  );
  return {
    valid: cron,
    raw: {
      APPROVED_TO_IMPLEMENT_REMOVAL_AUTOMATION_CRON: cron ? "true" : "false",
    },
  };
}

function applySecretGateOk(): boolean {
  return process.env.REMOVAL_AUTOMATION_CONFIRM_APPLY?.trim() === "true";
}

function endOfYesterdayUtc(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function loadWindowCursor(): { last_success_window_end: string | null } {
  if (!fs.existsSync(WINDOW_CURSOR_PATH)) return { last_success_window_end: null };
  try {
    const j = JSON.parse(fs.readFileSync(WINDOW_CURSOR_PATH, "utf8")) as {
      last_success_window_end?: string;
    };
    return { last_success_window_end: j.last_success_window_end ?? null };
  } catch {
    return { last_success_window_end: null };
  }
}

function computeWindow(): {
  start: string;
  end: string;
  span_days: number;
  rolling_days: number;
  overlap_day: boolean;
  catchup_mode: boolean;
} {
  const overrideStart = argValue("--window-start=");
  const overrideEnd = argValue("--window-end=");
  const rolling = rollingDays();

  if (overrideStart && overrideEnd) {
    return {
      start: overrideStart,
      end: overrideEnd,
      span_days: 0,
      rolling_days: rolling,
      overlap_day: false,
      catchup_mode: hasFlag("--catchup"),
    };
  }

  const end = endOfYesterdayUtc();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - rolling);
  start.setUTCHours(0, 0, 0, 0);

  const cursor = loadWindowCursor();
  let overlap_day = false;
  if (cursor.last_success_window_end) {
    const prevEnd = new Date(cursor.last_success_window_end);
    if (!Number.isNaN(prevEnd.getTime())) {
      const overlapStart = new Date(prevEnd);
      overlapStart.setUTCDate(overlapStart.getUTCDate() - 1);
      if (overlapStart < start) {
        start.setTime(overlapStart.getTime());
        overlap_day = true;
      }
    }
  }

  const span_days = Math.ceil((end.getTime() - start.getTime()) / 86400000);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    span_days,
    rolling_days: rolling,
    overlap_day,
    catchup_mode: hasFlag("--catchup") || span_days > rolling + 1,
  };
}

function advisoryLockKey(): string {
  return `removal_automation:${ORG_ID}:${STORE_ID}`;
}

function readRunLock(): { running: boolean; run_id?: string } {
  if (!fs.existsSync(RUN_LOCK_PATH)) return { running: false };
  try {
    const j = JSON.parse(fs.readFileSync(RUN_LOCK_PATH, "utf8")) as {
      status?: string;
      run_id?: string;
    };
    return { running: j.status === "running", run_id: j.run_id };
  } catch {
    return { running: false };
  }
}

function writeRunLock(runId: string, status: "running" | "idle"): void {
  fs.mkdirSync(path.dirname(RUN_LOCK_PATH), { recursive: true });
  fs.writeFileSync(
    RUN_LOCK_PATH,
    JSON.stringify(
      {
        status,
        run_id: runId,
        updated_at: new Date().toISOString(),
        org_id: ORG_ID,
        store_id: STORE_ID,
      },
      null,
      2,
    ),
  );
}

async function tryAcquireAdvisoryLock(): Promise<{ acquired: boolean; detail: string }> {
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) return { acquired: false, detail: "STAGING_DIRECT_POSTGRES_URL unset" };

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const r = await client.query(`SELECT pg_try_advisory_lock(hashtext($1::text)) AS ok`, [
      advisoryLockKey(),
    ]);
    const ok = Boolean(r.rows[0]?.ok);
    return { acquired: ok, detail: ok ? "pg_advisory_lock acquired" : "pg_advisory_lock held by other session" };
  } finally {
    await client.end();
  }
}

async function releaseAdvisoryLock(): Promise<void> {
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) return;
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(`SELECT pg_advisory_unlock(hashtext($1::text))`, [advisoryLockKey()]);
  } finally {
    await client.end();
  }
}

function plannedSteps(window: { start: string; end: string }, runId: string): PlannedStep[] {
  const fetchRunId = `${runId}-fetch`;
  return [
    {
      id: "fetch",
      pipeline_phase: "1_fetch_raw_upload",
      script: "scripts/sp-api-removal-reports-fetch-execute.ts",
      description: "SP-API Removal Order + Shipment Detail → raw_report_uploads + archive",
      dry_run_note: "Skipped — would call Amazon Reports API",
      apply_argv: [
        `--run-id=${fetchRunId}`,
        `--window-start=${window.start}`,
        `--window-end=${window.end}`,
      ],
      child_out_base: ".cursor/audit-reports/sp-api-removal-reports-fetch-execute",
    },
    {
      id: "domain_sync",
      pipeline_phase: "2_domain_sync_3_normalize_4_grouped_rebuild",
      script: "scripts/sp-api-removal-reports-domain-sync-execute.ts",
      description:
        "Import pipeline: staging normalize → amazon_removals/shipments; rebuild_expected_packages_from_removals",
      dry_run_note: "Skipped — requires upload IDs from fetch; uses import_pipeline_locks",
      apply_argv: ["--apply", `--run-id=${runId}-sync`],
      child_out_base: ".cursor/audit-reports/sp-api-removal-reports-domain-sync-execute",
    },
    {
      id: "verify",
      pipeline_phase: "5_verify_allocation",
      script: "scripts/removal-quantity-allocation-validation.ts",
      description: "Read-only allocation contract; abort if mismatch > 0",
      dry_run_note: "Skipped in dry-run (no child execute)",
      apply_argv: [`--run-id=${runId}-verify`],
      child_out_base: ".cursor/audit-reports/removal-quantity-allocation-validation",
    },
    {
      id: "resolver",
      pipeline_phase: "6_resolver_reconcile",
      script: "scripts/removal-post-sync-resolver-reconcile.ts",
      description: "Map-only resolver backfill on expected_packages (no product auto-create)",
      dry_run_note: "Skipped — would update resolver columns",
      apply_argv: ["--apply", `--run-id=${runId}-resolver`],
      child_out_base: ".cursor/audit-reports/removal-post-sync-resolver-reconcile",
    },
  ];
}

function runChild(
  step: PlannedStep,
  extraEnv: Record<string, string>,
): { ok: boolean; exit_code: number | null; signal: string | null } {
  const res = spawnSync("npx", ["tsx", step.script, ...step.apply_argv], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    shell: true,
  });
  return {
    ok: res.status === 0,
    exit_code: res.status,
    signal: res.signal,
  };
}

function readFetchUploadIds(fetchRunId: string): {
  order_upload_id: string | null;
  shipment_upload_id: string | null;
} {
  const manifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/sp-api-removal-reports-fetch-execute",
    fetchRunId,
    "manifest.json",
  );
  if (!fs.existsSync(manifestPath)) return { order_upload_id: null, shipment_upload_id: null };
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { upload_ids?: string[] };
  const ids = m.upload_ids ?? [];
  return {
    order_upload_id: ids[0] ?? null,
    shipment_upload_id: ids[1] ?? null,
  };
}

function readVerifyManifest(verifyRunId: string): { allocation_contract_valid: boolean | null } {
  const manifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/removal-quantity-allocation-validation",
    verifyRunId,
    "manifest.json",
  );
  if (!fs.existsSync(manifestPath)) return { allocation_contract_valid: null };
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    allocation_contract_valid?: boolean;
  };
  return { allocation_contract_valid: m.allocation_contract_valid ?? null };
}

async function maybeAlertWebhook(payload: Record<string, unknown>): Promise<void> {
  const url = process.env.REMOVAL_AUTOMATION_ALERT_WEBHOOK?.trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // non-fatal
  }
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = hasFlag("--apply");
  const manual = hasFlag("--manual");
  const skipFetch = hasFlag("--skip-fetch");
  const skipResolver = hasFlag("--skip-resolver");

  const outDir = path.join(process.cwd(), OUT_BASE_RUN, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const targetRef =
    process.env.REMOVAL_AUTOMATION_TARGET_REF?.trim() || getStagingProjectRef({ loadEnv: false });

  const blockers: string[] = [];
  let branch = "unknown";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    blockers.push("Could not read git branch.");
  }
  if (branch !== REQUIRED_BRANCH) {
    blockers.push(`Branch \`${branch}\` !== \`${REQUIRED_BRANCH}\`.`);
  }

  const orchestratorApproval = readOrchestratorApproval();
  if (apply) {
    if (!orchestratorApproval.valid) {
      blockers.push(
        `${ORCHESTRATOR_APPROVAL}: APPROVED_TO_IMPLEMENT_REMOVAL_AUTOMATION_CRON must be true.`,
      );
    }
    if (!applySecretGateOk()) {
      blockers.push(
        "REMOVAL_AUTOMATION_CONFIRM_APPLY must be true (set env or GitHub secret REMOVAL_AUTOMATION_APPLY_ENABLED).",
      );
    }
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    process.env.STAGING_SUPABASE_URL?.trim() ||
    "";
  const urlRef = refFromSupabaseUrl(supabaseUrl);
  if (!supabaseUrl || urlRef !== STAGING_REF) {
    blockers.push(`NEXT_PUBLIC_SUPABASE_URL ref must be staging ${STAGING_REF} (got ${urlRef ?? "missing"}).`);
  }
  if (targetRef !== STAGING_REF) {
    blockers.push(`REMOVAL_AUTOMATION_TARGET_REF must be ${STAGING_REF}.`);
  }
  if (urlRef === ORIGINAL_REF) {
    blockers.push(`Original ref ${ORIGINAL_REF} is forbidden.`);
  }

  const existingLock = readRunLock();
  if (apply && existingLock.running) {
    blockers.push(`Run lock active (run_id=${existingLock.run_id ?? "unknown"}) — overlapping run blocked.`);
  }

  const subApprovalStatus = SUB_APPROVALS.map((s) => ({
    step: s.step,
    path: s.path,
    ready: s.flags.every((f) => readFlagFromFile(s.path, f)),
    flags: Object.fromEntries(s.flags.map((f) => [f, readFlagFromFile(s.path, f) ? "true" : "false"])),
  }));

  if (apply) {
    for (const s of subApprovalStatus) {
      if (!s.ready) blockers.push(`Sub-approval not ready: ${s.path}`);
    }
    if (!process.env.STAGING_DIRECT_POSTGRES_URL?.trim()) {
      blockers.push("STAGING_DIRECT_POSTGRES_URL required for --apply.");
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
      blockers.push("SUPABASE_SERVICE_ROLE_KEY required for --apply.");
    }
  }

  const window = computeWindow();
  const steps = plannedSteps(window, runId).filter((s) => {
    if (skipFetch && s.id === "fetch") return false;
    if (skipResolver && s.id === "resolver") return false;
    return true;
  });

  const pipelineFlowMd = [
    "# Removal daily automation — pipeline flow",
    "",
    "| Phase | Step id | Implementation |",
    "|-------|---------|----------------|",
    "| 1. Fetch reports | fetch | `sp-api-removal-reports-fetch-execute.ts` |",
    "| 2. Raw upload + archive | fetch | `raw_report_uploads` + Supabase Storage |",
    "| 3. Domain sync | domain_sync | `sp-api-removal-reports-domain-sync-execute.ts` |",
    "| 4. Normalize (staging rows) | domain_sync | import pipeline Phase 2 |",
    "| 5. Grouped rebuild | domain_sync | `rebuild_expected_packages_from_removals` RPC |",
    "| 6. Verify allocation | verify | `removal-quantity-allocation-validation.ts` |",
    "| 7. Resolver reconcile | resolver | `removal-post-sync-resolver-reconcile.ts` |",
    "| 8. Audit | orchestrator | `removal-automation-run/<run_id>/` |",
    "",
    "## Schedule (GitHub Actions)",
    "",
    "| Local (America/Los_Angeles) | UTC cron |",
    "|-----------------------------|----------|",
    "| 06:00 | `0 13 * * *` |",
    "| 14:00 | `0 21 * * *` |",
    "",
    "## Mode",
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| Mode | **${apply ? "apply" : "dry-run"}** |`,
    `| Run ID | \`${runId}\` |`,
    `| Rolling days | ${window.rolling_days} |`,
    `| Window | \`${window.start}\` → \`${window.end}\` |`,
    `| Target ref | \`${STAGING_REF}\` only |`,
    "",
    "## Locking / idempotency",
    "",
    "- File run lock: `.cursor/audit-reports/removal-automation-run/.run-lock.json`",
    "- Postgres: `pg_try_advisory_lock(hashtext('removal_automation:org:store'))`",
    "- Shipment sync: `import_pipeline_locks` (org, store)",
    "- Fetch: `source_run.idempotency_key` per window + report type",
    "- GitHub Actions: `concurrency.cancel-in-progress: false`",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "pipeline-flow.md"), pipelineFlowMd + "\n");
  fs.writeFileSync(
    path.join(outDir, "step-plan.md"),
    [
      pipelineFlowMd.split("## Mode")[0],
      "",
      "| Step | Phase | Script | Apply |",
      "|------|-------|--------|-------|",
      ...steps.map(
        (s) =>
          `| ${s.id} | ${s.pipeline_phase} | \`${s.script}\` | ${apply ? "execute" : "skip"} |`,
      ),
    ].join("\n") + "\n",
  );

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt: "REMOVAL-DAILY-AUTOMATION-ORCHESTRATOR",
          run_id: runId,
          mode: apply ? "apply" : "dry-run",
          status: "BLOCKED",
          blockers,
          window,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ok: false, outDir, blockers }, null, 2));
    process.exit(apply ? 1 : 0);
  }

  if (!apply) {
    fs.writeFileSync(
      path.join(outDir, "dry-run-summary.md"),
      [
        "# Dry-run summary",
        "",
        "**No Amazon API. No database writes. No child scripts executed.**",
        "",
        "Preflight passed: branch, staging ref, window, step plan written.",
        "",
        "## Apply gates (both required)",
        "",
        "1. `APPROVED_TO_IMPLEMENT_REMOVAL_AUTOMATION_CRON=true` in approval file",
        "2. `REMOVAL_AUTOMATION_CONFIRM_APPLY=true` (env or GitHub `REMOVAL_AUTOMATION_APPLY_ENABLED` secret)",
        "",
        "## Sub-approvals",
        "",
        ...subApprovalStatus.map((s) => `- **${s.step}**: ${s.ready ? "ready" : "NOT READY"}`),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(path.join(outDir, "blockers.md"), "- None (dry-run)\n");

    const manifest = {
      prompt: "REMOVAL-DAILY-AUTOMATION-ORCHESTRATOR",
      run_id: runId,
      mode: "dry-run",
      status: "PASS",
      staging_ref: STAGING_REF,
      branch,
      manual,
      window,
      schedule: { timezone: "America/Los_Angeles", local_times: ["06:00", "14:00"] },
      sub_approvals: subApprovalStatus,
      steps_planned: steps.map((s) => s.id),
      orchestrator_approval: orchestratorApproval.raw,
      apply_secret_gate: false,
      exact_next_prompt:
        "REMOVAL-DAILY-AUTOMATION-APPLY-BURNIN — set approval + REMOVAL_AUTOMATION_APPLY_ENABLED secret, workflow_dispatch apply=true once",
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ ok: true, mode: "dry-run", outDir, window }, null, 2));
    return;
  }

  writeRunLock(runId, "running");
  const lock = await tryAcquireAdvisoryLock();
  if (!lock.acquired) {
    writeRunLock(runId, "idle");
    fs.writeFileSync(path.join(outDir, "blockers.md"), `- ${lock.detail}\n`);
    await maybeAlertWebhook({ run_id: runId, status: "BLOCKED_OVERLAP", detail: lock.detail });
    console.log(JSON.stringify({ ok: false, status: "BLOCKED_OVERLAP" }, null, 2));
    process.exit(2);
  }

  const execBlockers: string[] = [];
  const stepResults: Record<string, unknown>[] = [];
  let childEnv: Record<string, string> = {};

  try {
    for (const step of steps) {
      if (step.id === "domain_sync") {
        const uploads = readFetchUploadIds(`${runId}-fetch`);
        if (!uploads.order_upload_id || !uploads.shipment_upload_id) {
          execBlockers.push("Missing upload IDs from fetch manifest.");
          break;
        }
        childEnv = {
          REMOVAL_AUTOMATION_ORDER_UPLOAD_ID: uploads.order_upload_id,
          REMOVAL_AUTOMATION_SHIPMENT_UPLOAD_ID: uploads.shipment_upload_id,
        };
      }

      const result = runChild(step, childEnv);
      stepResults.push({ id: step.id, phase: step.pipeline_phase, ...result });

      if (!result.ok) {
        execBlockers.push(`Step ${step.id} failed (exit ${result.exit_code}).`);
        break;
      }

      if (step.id === "verify") {
        const v = readVerifyManifest(`${runId}-verify`);
        if (v.allocation_contract_valid === false) {
          execBlockers.push("Allocation verify failed.");
          break;
        }
      }
    }

    if (!execBlockers.length) {
      fs.writeFileSync(
        WINDOW_CURSOR_PATH,
        JSON.stringify(
          { last_success_window_end: window.end, run_id: runId, updated_at: new Date().toISOString() },
          null,
          2,
        ),
      );
    }
  } finally {
    writeRunLock(runId, "idle");
    await releaseAdvisoryLock();
  }

  fs.writeFileSync(path.join(outDir, "step-results.json"), JSON.stringify(stepResults, null, 2));
  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    execBlockers.length ? execBlockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None\n",
  );

  const status = execBlockers.length ? "FAIL" : "PASS";
  if (execBlockers.length) {
    await maybeAlertWebhook({ run_id: runId, status, blockers: execBlockers });
  }

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-DAILY-AUTOMATION-ORCHESTRATOR",
        run_id: runId,
        mode: "apply",
        status,
        staging_ref: STAGING_REF,
        window,
        step_results: stepResults,
        exact_next_prompt: execBlockers.length
          ? "REMOVAL-DAILY-AUTOMATION-DIAGNOSE"
          : "REMOVAL-DAILY-AUTOMATION-MONITOR",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ok: status === "PASS", outDir, status, execBlockers }, null, 2));
  if (execBlockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
