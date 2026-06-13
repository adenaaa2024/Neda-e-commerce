import "server-only";

import type { ReportsApiClient } from "./reports-api-client";
import {
  runReportsApiPullWorker,
  type ReportsApiPullRequest,
  type ReportsApiPullResult,
  type ReportsApiPullWorkerDeps,
  REPORTS_API_MAX_ATTEMPTS,
  REPORTS_API_REQUEST_BUDGET_MS,
} from "./reports-api-pull-worker";
import { REMOVAL_ORDER_PULL_PROFILE } from "./reports-api-worker-profile";
import { resolveRemovalReportsRunPipeline } from "./reports-api-removal-pipeline-mode";

export const REMOVAL_ORDER_REQUEST_BUDGET_MS = REPORTS_API_REQUEST_BUDGET_MS;
export const REMOVAL_ORDER_MAX_ATTEMPTS = REPORTS_API_MAX_ATTEMPTS;

export type RemovalOrderRunRequest = ReportsApiPullRequest;
export type RemovalOrderRunResult = ReportsApiPullResult;
export type RemovalOrderWorkerDeps = Omit<ReportsApiPullWorkerDeps, "profile"> & {
  client?: ReportsApiClient;
};

/** Net-new fetch stops at synthetic_upload_ready; resume promotes import unless runPipeline:false. */
export async function runRemovalOrderReportsWorker(
  req: RemovalOrderRunRequest,
  deps: RemovalOrderWorkerDeps = {},
): Promise<RemovalOrderRunResult> {
  const runPipeline = resolveRemovalReportsRunPipeline(req, deps);
  return runReportsApiPullWorker(req, {
    ...deps,
    runPipeline,
    profile: REMOVAL_ORDER_PULL_PROFILE,
  });
}
