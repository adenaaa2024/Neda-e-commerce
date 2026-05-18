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
import { REIMBURSEMENTS_PULL_PROFILE } from "./reports-api-worker-profile";

export const REIMBURSEMENTS_REQUEST_BUDGET_MS = REPORTS_API_REQUEST_BUDGET_MS;
export const REIMBURSEMENTS_MAX_ATTEMPTS = REPORTS_API_MAX_ATTEMPTS;

export type ReimbursementsRunRequest = ReportsApiPullRequest;
export type ReimbursementsRunResult = ReportsApiPullResult;
export type ReimbursementsWorkerDeps = Omit<ReportsApiPullWorkerDeps, "profile"> & {
  client?: ReportsApiClient;
};

export async function runReimbursementsReportsWorker(
  req: ReimbursementsRunRequest,
  deps: ReimbursementsWorkerDeps = {},
): Promise<ReimbursementsRunResult> {
  return runReportsApiPullWorker(req, { ...deps, profile: REIMBURSEMENTS_PULL_PROFILE });
}
