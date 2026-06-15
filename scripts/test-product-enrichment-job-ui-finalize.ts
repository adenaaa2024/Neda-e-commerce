/**
 * PRODUCT-ENRICHMENT-BACKEND-JOB-UI-FINALIZE — static + staging API smoke
 *   npx tsx scripts/test-product-enrichment-job-ui-finalize.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { readAsyncJobPhase1Approval } from "../lib/jobs/approval";
import { buildProductEnrichmentJobUiStatus } from "../lib/jobs/product-enrichment-job-status";
import { ASYNC_JOBS_STAGING_REF, assertAsyncJobsStagingOnly } from "../lib/jobs/staging-guard";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function staticChecks(): void {
  const hub = readFileSync(join(process.cwd(), "app/dashboard/products/pim/PimCatalogHub.tsx"), "utf8");
  const hook = readFileSync(join(process.cwd(), "app/dashboard/products/pim/usePimCatalogEnrichmentJob.ts"), "utf8");
  const panel = readFileSync(join(process.cwd(), "app/dashboard/products/pim/PimCatalogEnrichmentJobPanel.tsx"), "utf8");
  const state = readFileSync(join(process.cwd(), "app/dashboard/products/pim/pim-product-enrichment-job-ui-state.ts"), "utf8");
  const client = readFileSync(join(process.cwd(), "lib/pim-catalog-enrichment-job-client.ts"), "utf8");

  assert.match(hub, /Product Data Update/);
  assert.match(hub, /usePimCatalogEnrichmentJob/);
  assert.match(hub, /ProductDataUpdatePanel/);
  assert.doesNotMatch(hub, /<PimCatalogEnrichmentJobPanel/);
  assert.match(state, /derivePimProductEnrichmentCanonicalJobState/);
  assert.doesNotMatch(hub, /Browser loop \(legacy\)/);
  assert.doesNotMatch(hub, /Product Data Update run mode/);
  assert.doesNotMatch(hub, /PIM_DISPLAY_CURRENCIES/);
  assert.match(hub, /runs in the background/);
  assert.match(client, /\/api\/jobs\/enqueue/);
  assert.match(client, /\/api\/jobs\/active/);
  assert.doesNotMatch(client, /product_identifier_map/);

  assert.match(hook, /fetchProductEnrichmentJobStatus/);
  assert.match(hook, /canonicalJobState/);
  assert.match(hook, /hasActiveNonTerminalJob/);
  assert.match(hook, /cancelProductEnrichmentJob/);
  assert.match(hook, /resumeBackendJob/);
  assert.match(hook, /startPolling/);
  assert.match(hook, /stopPolling/);
  assert.doesNotMatch(hook, /drainProductEnrichmentJobTicks/);
  assert.match(client, /localStorage/);

  assert.match(panel, /Processed:/);
  assert.match(panel, /Cancel/);
  assert.match(panel, /Resume/);
  assert.match(panel, /Runs in the background/);

  assert.ok(readFileSync(join(process.cwd(), "app/api/jobs/[jobId]/route.ts"), "utf8").includes("GET"));
  assert.ok(readFileSync(join(process.cwd(), "app/api/jobs/active/route.ts"), "utf8").includes("findActiveBackgroundJob"));
}

function installServerOnlyShim(): void {
  const { createRequire } = require("node:module") as typeof import("node:module");
  const req = createRequire(import.meta.url);
  const mod = req("module") as { _load: (...args: unknown[]) => unknown };
  const original = mod._load.bind(mod);
  mod._load = (request: unknown, parent: unknown, isMain: unknown) => {
    if (request === "server-only") return {};
    return original(request, parent, isMain);
  };
}

async function integrationChecks(): Promise<void> {
  installServerOnlyShim();
  loadEnvLocalIntoProcess();
  const approval = readAsyncJobPhase1Approval();
  assert.ok(approval.approved, `approval: ${approval.reasons.join(", ")}`);
  assertAsyncJobsStagingOnly();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  assert.equal(refFromSupabaseUrl(url), ASYNC_JOBS_STAGING_REF);

  const { cancelJob, enqueueJob, tickJob } = await import("../lib/jobs/orchestrator");
  const { fetchJob, fetchJobStep, findActiveBackgroundJob } = await import("../lib/jobs/repository");

  const client = createClient(url, key, { auth: { persistSession: false } });
  const runKey = `pe-ui-finalize-${Date.now()}`;

  const enq = await enqueueJob(client, {
    organizationId: ORG,
    storeId: STORE,
    jobType: "product_enrichment",
    idempotencyKey: runKey,
    payload: { limit: 1, prioritize_incomplete: false },
  });
  assert.ok(enq.ok);

  const active = await findActiveBackgroundJob(client, {
    organizationId: ORG,
    storeId: STORE,
    jobType: "product_enrichment",
  });
  assert.ok(active?.id);

  const job = (await fetchJob(client, enq.jobId))!;
  const step0 = await fetchJobStep(client, enq.jobId, 0);
  const ui = buildProductEnrichmentJobUiStatus(job, step0);
  assert.equal(ui.running, true);

  await tickJob(client, enq.jobId, "ui-finalize-test");
  const afterTick = await fetchJob(client, enq.jobId);
  const stepAfter = await fetchJobStep(client, enq.jobId, 0);
  const uiAfter = buildProductEnrichmentJobUiStatus(afterTick!, stepAfter);
  assert.ok(uiAfter.batches_run >= 0);

  await cancelJob(client, enq.jobId);
  await tickJob(client, enq.jobId, "ui-finalize-cancel");
  const cancelled = await fetchJob(client, enq.jobId);
  assert.equal(cancelled?.status, "cancelled");

  const resumeKey = `pe-ui-resume-${Date.now()}`;
  const cursorIndex = uiAfter.last_cursor_index ?? 1;
  const resumeEnq = await enqueueJob(client, {
    organizationId: ORG,
    storeId: STORE,
    jobType: "product_enrichment",
    idempotencyKey: resumeKey,
    payload: { limit: 1, start_index: cursorIndex },
  });
  assert.ok(resumeEnq.ok);
  const resumeStep = await fetchJobStep(client, resumeEnq.jobId, 0);
  const resumeParams = (await import("../lib/jobs/workers/product-enrichment-job-state")).enrichmentParamsFromJob(
    (await fetchJob(client, resumeEnq.jobId))!,
    resumeStep!,
  );
  assert.equal(resumeParams.startIndex, cursorIndex);
}

async function main(): Promise<void> {
  staticChecks();
  let integration = "skipped";
  try {
    await integrationChecks();
    integration = "pass";
  } catch (e) {
    integration = e instanceof Error ? e.message : String(e);
  }

  const pass = integration === "pass";
  console.log(
    JSON.stringify(
      {
        ok: pass,
        static: "pass",
        integration,
        safe_to_continue: pass ? "yes" : "no",
      },
      null,
      2,
    ),
  );
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
