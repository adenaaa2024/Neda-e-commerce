import type { ProductEnrichmentJobUiStatus } from "@/lib/jobs/product-enrichment-job-status";

export type PimProductEnrichmentCanonicalJobState =
  | "idle"
  | "actively_advancing"
  | "paused_awaiting_user"
  | "running_db_idle"
  | "queued"
  | "terminal"
  | "error";

export function isTerminalProductEnrichmentJob(
  status: ProductEnrichmentJobUiStatus | null | undefined,
): boolean {
  if (!status) return false;
  return status.status === "completed" || status.status === "cancelled" || status.status === "failed";
}

export function derivePimProductEnrichmentCanonicalJobState(args: {
  jobId: string | null;
  jobStatus: ProductEnrichmentJobUiStatus | null;
  autoTickEnabled: boolean;
  jobErr: string | null;
}): PimProductEnrichmentCanonicalJobState {
  const { jobId, jobStatus, autoTickEnabled, jobErr } = args;

  if (!jobId && !jobStatus) return jobErr ? "error" : "idle";
  if (jobStatus && isTerminalProductEnrichmentJob(jobStatus)) return "terminal";
  if (jobErr && jobId && jobStatus && !isTerminalProductEnrichmentJob(jobStatus)) return "error";

  if (!jobStatus) return jobErr ? "error" : "idle";

  if (jobStatus.status === "queued") {
    if (jobStatus.needs_tick && !autoTickEnabled) return "paused_awaiting_user";
    if (autoTickEnabled && jobStatus.needs_tick) return "actively_advancing";
    return "queued";
  }

  if (jobStatus.status === "running") {
    if (jobStatus.cancel_requested) return "running_db_idle";
    if (jobStatus.needs_tick && !autoTickEnabled) return "paused_awaiting_user";
    if (autoTickEnabled && jobStatus.needs_tick) return "actively_advancing";
    return "running_db_idle";
  }

  return "idle";
}

export function hasActiveNonTerminalProductEnrichmentJob(args: {
  jobId: string | null;
  jobStatus: ProductEnrichmentJobUiStatus | null;
}): boolean {
  return Boolean(args.jobId && args.jobStatus && !isTerminalProductEnrichmentJob(args.jobStatus));
}

export function shortJobId(jobId: string | null | undefined): string | null {
  if (!jobId?.trim()) return null;
  return jobId.slice(0, 8);
}
