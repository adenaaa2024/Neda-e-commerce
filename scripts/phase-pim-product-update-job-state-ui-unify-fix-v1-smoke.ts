/**
 * PHASE-PIM-PRODUCT-UPDATE-JOB-STATE-UI-UNIFY-FIX-V1 — static smoke
 *   npx tsx scripts/phase-pim-product-update-job-state-ui-unify-fix-v1-smoke.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildProductEnrichmentJobUiStatus } from "../lib/jobs/product-enrichment-job-status";
import type { BackgroundJobRow, JobStepRow } from "../lib/jobs/types";
import { buildProductDataUpdatePanelProps } from "../app/dashboard/products/pim/mapProductDataUpdatePanelProps";
import {
  derivePimProductEnrichmentCanonicalJobState,
  hasActiveNonTerminalProductEnrichmentJob,
} from "../app/dashboard/products/pim/pim-product-enrichment-job-ui-state";

function orphanJobUiStatus() {
  const job = {
    id: "5580bfce-e426-4cb5-b600-4de6f0ddf548",
    status: "running",
    progress_pct: 1,
    cancel_requested_at: null,
    last_error_detail: null,
    last_error_code: null,
  } as unknown as BackgroundJobRow;
  const step = {
    cursor: {
      next_start_index: 1,
      continuation: { total_eligible: 15742, next_start_index: 1 },
      batches_run: 1,
    },
  } as unknown as JobStepRow;
  return buildProductEnrichmentJobUiStatus(job, step);
}

function staticFileChecks(): void {
  const hub = readFileSync(join(process.cwd(), "app/dashboard/products/pim/PimCatalogHub.tsx"), "utf8");
  const hook = readFileSync(join(process.cwd(), "app/dashboard/products/pim/usePimCatalogEnrichmentJob.ts"), "utf8");

  assert.match(hub, /ProductDataUpdatePanel/);
  assert.match(hook, /derivePimProductEnrichmentCanonicalJobState/);
  assert.match(hook, /hasActiveNonTerminalJob/);
  assert.doesNotMatch(hub, /<PimCatalogEnrichmentJobPanel/);
  assert.match(hook, /enableAutoTick\(\)/);
  assert.doesNotMatch(hook, /jobStatus\?\.running \|\| \(jobStatus\?\.needs_tick && autoTickEnabled\)/);
}

function orphanJobScenario(): void {
  const status = orphanJobUiStatus();
  const jobId = status.job_id;

  const canonical = derivePimProductEnrichmentCanonicalJobState({
    jobId,
    jobStatus: status,
    autoTickEnabled: false,
    jobErr: null,
  });
  assert.equal(canonical, "paused_awaiting_user");
  assert.equal(hasActiveNonTerminalProductEnrichmentJob({ jobId, jobStatus: status }), true);

  const props = buildProductDataUpdatePanelProps({
    jobId,
    jobStatus: status,
    autoTickEnabled: false,
    jobRunning: false,
    jobBusy: false,
    jobErr: null,
    lastRunAt: null,
    amazonSpConfigured: true,
    storeReady: true,
    hasFailedProducts: false,
    onStartApply: () => undefined,
    onStartPreview: () => undefined,
    onResume: () => undefined,
    onCancel: () => undefined,
    onRetryFailed: () => undefined,
    onRefreshStatus: () => undefined,
  });

  assert.equal(props.jobState, "paused");
  assert.equal(props.mode, "off");
  assert.equal(props.canStartApply, false);
  assert.equal(props.canStartPreview, false);
  assert.equal(props.canResume, true);
  assert.equal(props.canCancel, true);
  assert.match(String(props.stageLabel), /Awaiting resume/);
}

function advancingScenario(): void {
  const status = orphanJobUiStatus();
  const canonical = derivePimProductEnrichmentCanonicalJobState({
    jobId: status.job_id,
    jobStatus: status,
    autoTickEnabled: true,
    jobErr: null,
  });
  assert.equal(canonical, "actively_advancing");

  const props = buildProductDataUpdatePanelProps({
    jobId: status.job_id,
    jobStatus: status,
    autoTickEnabled: true,
    jobRunning: true,
    jobBusy: false,
    jobErr: null,
    lastRunAt: null,
    amazonSpConfigured: true,
    storeReady: true,
    hasFailedProducts: false,
    onStartApply: () => undefined,
    onStartPreview: () => undefined,
    onResume: () => undefined,
    onCancel: () => undefined,
    onRetryFailed: () => undefined,
    onRefreshStatus: () => undefined,
  });

  assert.equal(props.jobState, "running");
  assert.equal(props.mode, "apply");
  assert.equal(props.canStartApply, false);
}

function main(): void {
  staticFileChecks();
  orphanJobScenario();
  advancingScenario();
  console.log(
    JSON.stringify(
      {
        phase: "PHASE-PIM-PRODUCT-UPDATE-JOB-STATE-UI-UNIFY-FIX-V1",
        ok: true,
        smoke: "pass",
      },
      null,
      2,
    ),
  );
}

main();
