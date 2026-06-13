import type { ReportsApiPullRequest, ReportsApiPullWorkerDeps } from "./reports-api-pull-worker";

/**
 * Removal Reports API workers stop net-new fetches at synthetic_upload_ready (fetch-only).
 * Resuming an existing upload promotes through UniversalImporter unless runPipeline is false.
 */
export function resolveRemovalReportsRunPipeline(
  req: Pick<ReportsApiPullRequest, "uploadId">,
  deps: Pick<ReportsApiPullWorkerDeps, "runPipeline">,
): boolean {
  if (deps.runPipeline === false) return false;
  if (deps.runPipeline === true) return true;
  return Boolean(req.uploadId?.trim());
}
