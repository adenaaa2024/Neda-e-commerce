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
import { FEE_PREVIEW_PULL_PROFILE } from "./reports-api-worker-profile";

export const FEE_PREVIEW_REQUEST_BUDGET_MS = REPORTS_API_REQUEST_BUDGET_MS;
export const FEE_PREVIEW_MAX_ATTEMPTS = REPORTS_API_MAX_ATTEMPTS;

export type FeePreviewRunRequest = ReportsApiPullRequest;
export type FeePreviewRunResult = ReportsApiPullResult;
export type FeePreviewWorkerDeps = Omit<ReportsApiPullWorkerDeps, "profile"> & {
  client?: ReportsApiClient;
};

/** Full fetch + full pipeline for FBA estimated fee preview data. */
export async function runFeePreviewReportsWorker(
  req: FeePreviewRunRequest,
  deps: FeePreviewWorkerDeps = {},
): Promise<FeePreviewRunResult> {
  return runReportsApiPullWorker(req, { ...deps, profile: FEE_PREVIEW_PULL_PROFILE });
}
