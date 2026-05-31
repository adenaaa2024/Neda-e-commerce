/**
 * PRODUCT-ENRICHMENT-BACKEND-JOB-WIRE-WORKER-WAVE2 — worker smoke (staging)
 *
 *   npx tsx scripts/test-product-enrichment-job-worker-smoke.ts --run-id=<UTC>
 */
import * as crypto from "node:crypto";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { readAsyncJobPhase1Approval } from "../lib/jobs/approval";
import { ASYNC_JOBS_STAGING_REF, assertAsyncJobsStagingOnly } from "../lib/jobs/staging-guard";
import {
  enrichmentParamsFromJob,
  mergeEnrichmentJobMetrics,
  PRODUCT_ENRICHMENT_JOB_PAUSE_RESUME_GAP,
} from "../lib/jobs/workers/product-enrichment-job-state";
import type { BackgroundJobRow, JobStepRow } from "../lib/jobs/types";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT_BASE = ".cursor/audit-reports/product-enrichment-backend-job-wire-worker-wave2";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function installServerOnlyShim(): void {
  const req = createRequire(import.meta.url);
  const mod = req("module") as { _load: (...args: unknown[]) => unknown };
  const original = mod._load.bind(mod);
  mod._load = (request: unknown, parent: unknown, isMain: unknown) => {
    if (request === "server-only") return {};
    return original(request, parent, isMain);
  };
}

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function unitChecks(): Record<string, boolean> {
  const job = {
    organization_id: ORG,
    store_id: STORE,
    payload: { limit: 3, prioritize_incomplete: true },
  } as BackgroundJobRow;
  const step = {
    input: {},
    cursor: { start_index: 12, batches_run: 2 },
  } as JobStepRow;

  const params = enrichmentParamsFromJob(job, step);
  assert(params.organizationId === ORG, "org from job row");
  assert(params.storeId === STORE, "store from job row");
  assert(params.startIndex === 12, "resume start_index from cursor");
  assert(params.limit === 3, "limit from payload");
  assert(params.prioritizeIncomplete === true, "prioritize from payload");

  const merged = mergeEnrichmentJobMetrics(
    { enriched_images: 2, failed: 1, start_index: 0, batch_size: 80 },
    { enriched_images: 1, failed: 0, start_index: 80, batch_size: 80 },
  );
  assert(merged.enriched_images === 3, "sum enriched_images");
  assert(merged.failed === 1, "sum failed");
  assert(merged.start_index === 80, "start_index from latest batch");
  assert(merged.batch_size === 160, "sum batch_size");

  return {
    payload_mapping: true,
    metric_merge: true,
    pause_resume_gap_documented: !PRODUCT_ENRICHMENT_JOB_PAUSE_RESUME_GAP.explicitPausedStatus,
  };
}

async function main(): Promise<void> {
  installServerOnlyShim();
  const { cancelJob, enqueueJob, tickJob } = await import("../lib/jobs/orchestrator");
  const { fetchJob, fetchJobStep } = await import("../lib/jobs/repository");
  const { resolveWorker } = await import("../lib/jobs/worker-registry");

  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const unit = unitChecks();
  const approval = readAsyncJobPhase1Approval();
  assertAsyncJobsStagingOnly();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const ref = refFromSupabaseUrl(url);
  if (ref !== ASYNC_JOBS_STAGING_REF) {
    throw new Error(`Staging ref guard failed (expected ${ASYNC_JOBS_STAGING_REF})`);
  }
  if (!approval.approved) {
    throw new Error(`Approval gate failed: ${approval.reasons.join(", ")}`);
  }

  const worker = resolveWorker("product_enrichment");
  assert(worker != null && worker.name === "runProductEnrichmentWorker", "registry wired");

  const client = createClient(url, key, { auth: { persistSession: false } });
  const smokeKey = `pe-worker-smoke-${runId}-${crypto.randomBytes(4).toString("hex")}`;

  const enqueueRes = await enqueueJob(client, {
    organizationId: ORG,
    storeId: STORE,
    jobType: "product_enrichment",
    idempotencyKey: smokeKey,
    payload: {
      limit: 1,
      prioritize_incomplete: false,
      include_enrichment_debug: false,
    },
    steps: [
      {
        step_key: "product_enrichment",
        worker_kind: "product_enrichment",
        input: {},
        budget_ms: 120_000,
      },
    ],
  });

  const tick1 = await tickJob(client, enqueueRes.jobId, "pe-worker-smoke");
  const stepAfter1 = await fetchJobStep(client, enqueueRes.jobId, 0);
  const jobAfter1 = await fetchJob(client, enqueueRes.jobId);

  const cancelKey = `pe-worker-cancel-${runId}-${crypto.randomBytes(4).toString("hex")}`;
  const cancelEnqueue = await enqueueJob(client, {
    organizationId: ORG,
    storeId: STORE,
    jobType: "product_enrichment",
    idempotencyKey: cancelKey,
    payload: { limit: 1 },
  });
  await cancelJob(client, cancelEnqueue.jobId);
  const cancelJobRow = await fetchJob(client, cancelEnqueue.jobId);

  const checks: Record<string, unknown> = {
    ...unit,
    worker_registered: true,
    enqueue_ok: enqueueRes.ok,
    tick1_ok: tick1.ok,
    tick1_status: tick1.status,
    tick1_has_output: Boolean(stepAfter1?.output && Object.keys(stepAfter1.output).length > 0),
    tick1_has_metrics: Boolean(
      stepAfter1?.output &&
        typeof stepAfter1.output === "object" &&
        "metrics" in (stepAfter1.output as Record<string, unknown>),
    ),
    tick1_cursor_batches: (stepAfter1?.cursor as { batches_run?: number })?.batches_run ?? 0,
    job_not_skeleton_error:
      jobAfter1?.last_error_code !== "worker_skeleton" && tick1.errorCode !== "worker_skeleton",
    cancel_queued_ok: cancelJobRow?.status === "cancelled",
    pause_resume_gap: PRODUCT_ENRICHMENT_JOB_PAUSE_RESUME_GAP,
  };

  const pass =
    unit.payload_mapping &&
    unit.metric_merge &&
    enqueueRes.ok &&
    tick1.ok &&
    checks.job_not_skeleton_error === true &&
    checks.tick1_has_metrics === true &&
    checks.cancel_queued_ok === true;

  const manifest = {
    prompt: "PRODUCT-ENRICHMENT-BACKEND-JOB-WIRE-WORKER-WAVE2",
    run_id: runId,
    staging_ref: ASYNC_JOBS_STAGING_REF,
    wave1_safe: true,
    worker_kind: "product_enrichment",
    library: "runPimCatalogEnrichmentBatch",
    browser_route_unchanged: "/api/dashboard/products/catalog/enrich-images",
    smoke_status: pass ? "PASS" : "FAIL",
    checks,
    job_id: enqueueRes.jobId,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "smoke-results.json"), JSON.stringify({ checks, pass }, null, 2));
  fs.writeFileSync(
    path.join(outDir, "implementation-summary.md"),
    [
      "# PRODUCT-ENRICHMENT-BACKEND-JOB-WIRE-WORKER-WAVE2",
      "",
      `- Worker: \`lib/jobs/workers/product-enrichment-worker.ts\``,
      `- Job state: \`lib/jobs/workers/product-enrichment-job-state.ts\``,
      `- Registry: \`product_enrichment\` → \`runProductEnrichmentWorker\``,
      `- Batch library: \`runPimCatalogEnrichmentBatch\` (Wave1, unchanged rules)`,
      `- Browser loop: unchanged (\`PimCatalogHub\` → enrich-images route)`,
      `- One tick = one enrichment batch (max 80 products); \`needsTick\` when continuation exists`,
      `- Cursor persists: start_index, metrics, failures, failed_product_ids, continuation`,
      "",
      "## Pause/resume gap",
      "",
      `- Resume via cursor: **yes** (stop ticking; resume ticking same job)`,
      `- Explicit \`paused\` job status: **no** (schema gap — not faked)`,
      `- \`retryJob\` clears cursor: **yes** (documented limitation)`,
      "",
      `## Smoke: **${pass ? "PASS" : "FAIL"}**`,
    ].join("\n"),
  );

  console.log(JSON.stringify(manifest, null, 2));
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
