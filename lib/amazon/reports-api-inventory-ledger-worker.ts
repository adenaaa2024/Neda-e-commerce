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
import { INVENTORY_LEDGER_PULL_PROFILE } from "./reports-api-worker-profile";

export const INVENTORY_LEDGER_REQUEST_BUDGET_MS = REPORTS_API_REQUEST_BUDGET_MS;
export const INVENTORY_LEDGER_MAX_ATTEMPTS = REPORTS_API_MAX_ATTEMPTS;

export type InventoryLedgerRunRequest = ReportsApiPullRequest;
export type InventoryLedgerRunResult = ReportsApiPullResult;
export type InventoryLedgerWorkerDeps = Omit<ReportsApiPullWorkerDeps, "profile"> & {
  client?: ReportsApiClient;
};

/** Full fetch + full pipeline. Amazon Detail View (not Daily Summary) required for valid ledger data. */
export async function runInventoryLedgerReportsWorker(
  req: InventoryLedgerRunRequest,
  deps: InventoryLedgerWorkerDeps = {},
): Promise<InventoryLedgerRunResult> {
  return runReportsApiPullWorker(req, { ...deps, profile: INVENTORY_LEDGER_PULL_PROFILE });
}
