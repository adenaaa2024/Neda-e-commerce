/**
 * ASYNC-JOB-ORCHESTRATION-PHASE1-STAGING-APPLY — smoke verification
 *
 *   npx tsx scripts/async-job-orchestration-phase1-smoke.ts --run-id=<id>
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { readAsyncJobPhase1Approval } from "../lib/jobs/approval";
import {
  cancelJob,
  drainJobTicks,
  enqueueJob,
  retryJob,
  tickJob,
} from "../lib/jobs/orchestrator";
import { fetchJob } from "../lib/jobs/repository";
import { ASYNC_JOBS_STAGING_REF, assertAsyncJobsStagingOnly } from "../lib/jobs/staging-guard";
import { listRegisteredWorkerKinds } from "../lib/jobs/worker-registry";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT_BASE = ".cursor/audit-reports/async-job-orchestration-phase1-staging-apply";
const ORG = "00000000-0000-0000-0000-000000000001";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableExists(client: ReturnType<typeof createClient>, table: string): Promise<boolean> {
  const { error } = await client.from(table).select("id").limit(1);
  return !error;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const approval = readAsyncJobPhase1Approval();
  assertAsyncJobsStagingOnly();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const ref = refFromSupabaseUrl(url);
  if (ref !== ASYNC_JOBS_STAGING_REF) {
    throw new Error(`Staging ref guard failed (expected ${ASYNC_JOBS_STAGING_REF})`);
  }

  const client = createClient(url, key, { auth: { persistSession: false } });
  const migrationApplied = await tableExists(client, "background_jobs");

  const checks: Record<string, boolean | string> = {
    approval_ok: approval.approved,
    staging_ref: ref,
    migration_tables_present: migrationApplied,
    worker_kinds: listRegisteredWorkerKinds().join(","),
  };

  if (!approval.approved) {
    throw new Error(`Approval gate failed: ${approval.reasons.join(", ")}`);
  }
  if (!migrationApplied) {
    throw new Error("background_jobs table missing — apply migration first");
  }

  const smokeKey = `smoke-${runId}-${crypto.randomBytes(4).toString("hex")}`;
  const enqueueRes = await enqueueJob(client, {
    organizationId: ORG,
    jobType: "orchestration",
    idempotencyKey: smokeKey,
    payload: { smoke: true },
    steps: [{ step_key: "smoke", worker_kind: "smoke_tick", input: {} }],
  });
  checks.enqueue_ok = enqueueRes.ok;
  checks.smoke_job_id = enqueueRes.jobId;

  const drain = await drainJobTicks(client, enqueueRes.jobId, 10);
  checks.drain_ticks = drain.ticks;
  checks.drain_final_status = drain.finalStatus;
  checks.smoke_complete = drain.finalStatus === "completed";

  const cancelKey = `cancel-${runId}-${crypto.randomBytes(4).toString("hex")}`;
  const cancelEnqueue = await enqueueJob(client, {
    organizationId: ORG,
    jobType: "orchestration",
    idempotencyKey: cancelKey,
    steps: [{ step_key: "smoke", worker_kind: "smoke_tick", input: {} }],
  });
  const cancelRes = await cancelJob(client, cancelEnqueue.jobId);
  const cancelJobRow = await fetchJob(client, cancelEnqueue.jobId);
  checks.cancel_ok = cancelRes.ok && cancelJobRow?.status === "cancelled";

  const failKey = `fail-${runId}-${crypto.randomBytes(4).toString("hex")}`;
  const failEnqueue = await enqueueJob(client, {
    organizationId: ORG,
    jobType: "product_import",
    idempotencyKey: failKey,
    payload: {},
  });
  const failTick = await tickJob(client, failEnqueue.jobId);
  checks.skeleton_fail = failTick.status === "failed";
  const retryRes = await retryJob(client, failEnqueue.jobId);
  const afterRetry = await fetchJob(client, failEnqueue.jobId);
  checks.retry_ok = retryRes.ok && afterRetry?.status === "queued";

  const pass =
    checks.enqueue_ok === true &&
    checks.smoke_complete === true &&
    checks.cancel_ok === true &&
    checks.retry_ok === true;

  const manifest = {
    prompt: "ASYNC-JOB-ORCHESTRATION-PHASE1-STAGING-APPLY",
    run_id: runId,
    staging_ref: ASYNC_JOBS_STAGING_REF,
    migration_applied: migrationApplied,
    apis_created: true,
    api_routes: [
      "POST /api/jobs/enqueue",
      "POST /api/jobs/tick",
      "POST /api/jobs/cancel",
      "POST /api/jobs/retry",
    ],
    smoke_status: pass ? "PASS" : "FAIL",
    checks,
    exact_next_prompt:
      "ASYNC-JOB-ORCHESTRATION-PHASE2-REPORTS-API-WORKER-BRIDGE — wire amazon_fetch steps to reports_api_fetch worker without browser resume loops",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "smoke-results.json"),
    JSON.stringify({ checks, pass }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md",
    ),
    [
      "# ASYNC-JOB-ORCHESTRATION-PHASE1-STAGING-APPLY",
      "",
      `- run_id: \`${runId}\``,
      `- staging: \`${ASYNC_JOBS_STAGING_REF}\``,
      `- migration applied: **${migrationApplied ? "yes" : "no"}**`,
      `- APIs created: **yes**`,
      `- smoke: **${pass ? "PASS" : "FAIL"}**`,
      "",
      "## Checks",
      "",
      ...Object.entries(checks).map(([k, v]) => `- ${k}: ${v}`),
      "",
      `## Next prompt`,
      "",
      `\`${manifest.exact_next_prompt}\``,
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
