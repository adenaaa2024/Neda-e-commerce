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
import { SETTLEMENT_PULL_PROFILE } from "./reports-api-worker-profile";

export const SETTLEMENT_REQUEST_BUDGET_MS = REPORTS_API_REQUEST_BUDGET_MS;
export const SETTLEMENT_MAX_ATTEMPTS = REPORTS_API_MAX_ATTEMPTS;

export type SettlementRunRequest = ReportsApiPullRequest;
export type SettlementRunResult = ReportsApiPullResult;
export type SettlementWorkerDeps = Omit<ReportsApiPullWorkerDeps, "profile"> & {
  client?: ReportsApiClient;
};

export async function runSettlementReportsWorker(
  req: SettlementRunRequest,
  deps: SettlementWorkerDeps = {},
): Promise<SettlementRunResult> {
  return runReportsApiPullWorker(req, { ...deps, profile: SETTLEMENT_PULL_PROFILE });
}
