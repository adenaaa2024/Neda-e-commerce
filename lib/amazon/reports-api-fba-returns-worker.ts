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
import { FBA_RETURNS_PULL_PROFILE } from "./reports-api-worker-profile";

export const FBA_RETURNS_REQUEST_BUDGET_MS = REPORTS_API_REQUEST_BUDGET_MS;
export const FBA_RETURNS_MAX_ATTEMPTS = REPORTS_API_MAX_ATTEMPTS;

export type FbaReturnsRunRequest = ReportsApiPullRequest;
export type FbaReturnsRunResult = ReportsApiPullResult;
export type FbaReturnsWorkerDeps = Omit<ReportsApiPullWorkerDeps, "profile"> & {
  client?: ReportsApiClient;
};

/** Full fetch + full pipeline (no removal fetch-only mode needed). */
export async function runFbaReturnsReportsWorker(
  req: FbaReturnsRunRequest,
  deps: FbaReturnsWorkerDeps = {},
): Promise<FbaReturnsRunResult> {
  return runReportsApiPullWorker(req, { ...deps, profile: FBA_RETURNS_PULL_PROFILE });
}
