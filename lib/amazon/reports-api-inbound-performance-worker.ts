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
import { INBOUND_PERFORMANCE_PULL_PROFILE } from "./reports-api-worker-profile";

export const INBOUND_PERFORMANCE_REQUEST_BUDGET_MS = REPORTS_API_REQUEST_BUDGET_MS;
export const INBOUND_PERFORMANCE_MAX_ATTEMPTS = REPORTS_API_MAX_ATTEMPTS;

export type InboundPerformanceRunRequest = ReportsApiPullRequest;
export type InboundPerformanceRunResult = ReportsApiPullResult;
export type InboundPerformanceWorkerDeps = Omit<ReportsApiPullWorkerDeps, "profile"> & {
  client?: ReportsApiClient;
};

/** Full fetch + full pipeline for FBA inbound shipment performance data. */
export async function runInboundPerformanceReportsWorker(
  req: InboundPerformanceRunRequest,
  deps: InboundPerformanceWorkerDeps = {},
): Promise<InboundPerformanceRunResult> {
  return runReportsApiPullWorker(req, { ...deps, profile: INBOUND_PERFORMANCE_PULL_PROFILE });
}
