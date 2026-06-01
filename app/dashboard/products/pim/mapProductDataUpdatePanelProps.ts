import type { ProductEnrichmentJobUiStatus } from "@/lib/jobs/product-enrichment-job-status";
import type {
  ProductDataUpdateJobState,
  ProductDataUpdateMode,
  ProductDataUpdatePanelProps,
} from "./ProductDataUpdatePanel";

function mapJobState(status: ProductEnrichmentJobUiStatus | null, running: boolean): ProductDataUpdateJobState {
  if (!status) return "idle";
  if (status.cancel_requested && (status.status === "running" || status.status === "queued")) {
    return "paused";
  }
  if (running) return "running";
  if (status.status === "completed") return "completed";
  if (status.status === "failed") return "failed";
  if (status.status === "cancelled") return "cancelled";
  if (status.status === "queued" || status.status === "running") return "running";
  return "idle";
}

export function buildProductDataUpdatePanelProps(args: {
  jobStatus: ProductEnrichmentJobUiStatus | null;
  jobRunning: boolean;
  jobBusy: boolean;
  jobErr: string | null;
  lastRunAt: string | null;
  amazonSpConfigured: boolean;
  storeReady: boolean;
  onStartApply: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRetryFailed: () => void;
  onRefreshStatus: () => void;
  hasFailedProducts: boolean;
}): ProductDataUpdatePanelProps {
  const { jobStatus, jobRunning, jobBusy, jobErr, lastRunAt } = args;
  const jobState = mapJobState(jobStatus, jobRunning);
  const mode: ProductDataUpdateMode = jobRunning || jobState === "completed" ? "apply" : "off";
  const progressPct =
    jobStatus?.progress_pct != null
      ? jobStatus.progress_pct
      : jobStatus?.total != null && jobStatus.total > 0
        ? Math.round((jobStatus.processed / jobStatus.total) * 100)
        : null;

  return {
    jobState,
    mode,
    progressPct,
    stageLabel: jobStatus
      ? `${jobStatus.status}${jobStatus.total != null ? ` · ${jobStatus.processed}/${jobStatus.total}` : ""}`
      : null,
    lastRunAt,
    nextRunAt: null,
    lastError: jobErr ?? jobStatus?.last_error ?? null,
    rowsProcessed: jobStatus?.processed ?? null,
    rowsTotal: jobStatus?.total ?? null,
    busy: jobBusy,
    canStartPreview: false,
    canStartApply: args.storeReady && args.amazonSpConfigured && !jobBusy && !jobRunning,
    canPause: false,
    canResume: Boolean(jobStatus?.can_resume) && !jobBusy,
    canCancel: Boolean(jobRunning && jobStatus?.job_id),
    canRetryFailed: args.hasFailedProducts && !jobBusy && !jobRunning,
    onStartPreview: () => undefined,
    onStartApply: args.onStartApply,
    onPause: () => undefined,
    onResume: args.onResume,
    onCancel: args.onCancel,
    onRetryFailed: args.onRetryFailed,
    onRefreshStatus: args.onRefreshStatus,
  };
}
