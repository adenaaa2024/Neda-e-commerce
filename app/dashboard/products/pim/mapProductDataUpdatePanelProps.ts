import type { ProductEnrichmentJobUiStatus } from "@/lib/jobs/product-enrichment-job-status";
import type { ProductDataUpdatePreviewSummary } from "@/lib/pim-catalog-enrichment-preview-samples";
import type {
  ProductDataUpdateJobState,
  ProductDataUpdateMode,
  ProductDataUpdatePanelProps,
} from "./ProductDataUpdatePanel";
import {
  derivePimProductEnrichmentCanonicalJobState,
  hasActiveNonTerminalProductEnrichmentJob,
  shortJobId,
  type PimProductEnrichmentCanonicalJobState,
} from "./pim-product-enrichment-job-ui-state";

function mapCanonicalToPanelState(
  canonical: PimProductEnrichmentCanonicalJobState,
  status: ProductEnrichmentJobUiStatus | null,
): ProductDataUpdateJobState {
  switch (canonical) {
    case "actively_advancing":
      return "running";
    case "paused_awaiting_user":
    case "running_db_idle":
    case "queued":
      return "paused";
    case "terminal":
      if (status?.status === "completed") return "completed";
      if (status?.status === "failed") return "failed";
      if (status?.status === "cancelled") return "cancelled";
      return "idle";
    case "error":
      return status?.status === "failed" ? "failed" : "idle";
    default:
      return "idle";
  }
}

function buildStageLabel(
  canonical: PimProductEnrichmentCanonicalJobState,
  status: ProductEnrichmentJobUiStatus | null,
): string | null {
  if (!status) return canonical === "error" ? "error" : null;
  const progress =
    status.total != null ? ` · ${status.processed}/${status.total}` : "";
  switch (canonical) {
    case "paused_awaiting_user":
      return `Awaiting resume (server ${status.status})${progress}`;
    case "running_db_idle":
      return `Server ${status.status} — not advancing${progress}`;
    case "actively_advancing":
      return `Applying updates · ${status.status}${progress}`;
    case "queued":
      return `Queued${progress}`;
    default:
      return `${status.status}${progress}`;
  }
}

export function buildProductDataUpdatePanelProps(args: {
  jobId: string | null;
  jobStatus: ProductEnrichmentJobUiStatus | null;
  autoTickEnabled: boolean;
  jobRunning: boolean;
  jobBusy: boolean;
  jobErr: string | null;
  lastRunAt: string | null;
  amazonSpConfigured: boolean;
  storeReady: boolean;
  onStartPreview: () => void;
  onStartApply: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRetryFailed: () => void;
  onRefreshStatus: () => void;
  hasFailedProducts: boolean;
  previewBusy?: boolean;
  previewError?: string | null;
  previewSummary?: ProductDataUpdatePreviewSummary | null;
  previewLastRunAt?: string | null;
}): ProductDataUpdatePanelProps {
  const { jobStatus, jobRunning, jobBusy, jobErr, lastRunAt, jobId, autoTickEnabled } = args;
  const canonical = derivePimProductEnrichmentCanonicalJobState({
    jobId,
    jobStatus,
    autoTickEnabled,
    jobErr,
  });
  const hasActiveJob = hasActiveNonTerminalProductEnrichmentJob({ jobId, jobStatus });
  const previewBusy = Boolean(args.previewBusy);
  const jobState = mapCanonicalToPanelState(canonical, jobStatus);
  const mode: ProductDataUpdateMode = jobRunning ? "apply" : args.previewSummary ? "dry-run" : "off";
  const progressPct =
    jobStatus?.progress_pct != null
      ? jobStatus.progress_pct
      : jobStatus?.total != null && jobStatus.total > 0
        ? Math.round((jobStatus.processed / jobStatus.total) * 100)
        : null;

  const canResume =
    (canonical === "paused_awaiting_user" ||
      canonical === "running_db_idle" ||
      canonical === "queued" ||
      Boolean(jobStatus?.can_resume)) &&
    !jobBusy;

  return {
    jobState,
    mode,
    progressPct,
    stageLabel: buildStageLabel(canonical, jobStatus),
    lastRunAt: args.previewLastRunAt ?? lastRunAt,
    nextRunAt: null,
    lastError: jobErr ?? jobStatus?.last_error ?? null,
    rowsProcessed: jobStatus?.processed ?? null,
    rowsTotal: jobStatus?.total ?? null,
    jobIdShort: shortJobId(jobId),
    busy: jobBusy || previewBusy,
    canStartPreview: args.storeReady && args.amazonSpConfigured && !jobBusy && !previewBusy && !hasActiveJob,
    canStartApply: args.storeReady && args.amazonSpConfigured && !jobBusy && !previewBusy && !hasActiveJob,
    canPause: false,
    canResume,
    canCancel: hasActiveJob,
    canRetryFailed: args.hasFailedProducts && !jobBusy && !hasActiveJob,
    onStartPreview: args.onStartPreview,
    onStartApply: args.onStartApply,
    onPause: () => undefined,
    onResume: args.onResume,
    onCancel: args.onCancel,
    onRetryFailed: args.onRetryFailed,
    onRefreshStatus: args.onRefreshStatus,
    previewBusy,
    previewError: args.previewError ?? null,
    previewSummary: args.previewSummary ?? null,
  };
}
