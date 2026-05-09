import type { RawReportUploadMetadata } from "./raw-report-upload-metadata";

/** Dashboard-facing snapshot built only from `raw_report_uploads` (no ETL round-trip). */
export function buildPimImportJobStatusPayload(input: {
  jobId: string;
  metadata: RawReportUploadMetadata | Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  const meta = (input.metadata && typeof input.metadata === "object" ? input.metadata : {}) as Record<string, unknown>;
  const job = (meta.pim_import_job && typeof meta.pim_import_job === "object" && !Array.isArray(meta.pim_import_job)
    ? meta.pim_import_job
    : {}) as Record<string, unknown>;
  const pr = meta.pim_preview_result && typeof meta.pim_preview_result === "object" && !Array.isArray(meta.pim_preview_result)
    ? (meta.pim_preview_result as Record<string, unknown>)
    : null;

  const lifecycle = String(job.lifecycle ?? "");
  const previewStatus = String(meta.preview_status ?? "");
  const topStatus = String(meta.import_job_status ?? "");

  let job_status = topStatus || previewStatus || lifecycle || "uploaded";
  if (previewStatus === "preview_ready" || pr?.status === "preview_ready") job_status = "preview_ready";
  else if (lifecycle === "completed") job_status = "completed";
  else if (lifecycle === "failed" || previewStatus === "failed") job_status = "failed";
  else if (meta.pim_import_cancelled) job_status = "cancelled";

  const scan = job.scan_cursor && typeof job.scan_cursor === "object" && !Array.isArray(job.scan_cursor)
    ? (job.scan_cursor as Record<string, unknown>)
    : null;
  const applyCur = job.apply_cursor && typeof job.apply_cursor === "object" && !Array.isArray(job.apply_cursor)
    ? (job.apply_cursor as Record<string, unknown>)
    : null;

  const rowsTotal =
    typeof meta.row_count === "number"
      ? meta.row_count
      : typeof job.import_total_rows === "number"
        ? job.import_total_rows
        : typeof scan?.total_rows === "number"
          ? scan.total_rows
          : null;

  const rowsProcessed =
    typeof scan?.data_row === "number"
      ? scan.data_row
      : typeof applyCur?.data_row === "number"
        ? applyCur.data_row
        : typeof job.progress_rows === "number"
          ? job.progress_rows
          : null;

  const quality =
    pr?.raw_quality && typeof pr.raw_quality === "object" && !Array.isArray(pr.raw_quality)
      ? pr.raw_quality
      : job.preview_quality && typeof job.preview_quality === "object" && !Array.isArray(job.preview_quality)
        ? job.preview_quality
        : null;

  const publicQuality =
    pr?.quality && typeof pr.quality === "object" && !Array.isArray(pr.quality) ? pr.quality : null;

  const previewProgress =
    job.preview_progress && typeof job.preview_progress === "object" && !Array.isArray(job.preview_progress)
      ? (job.preview_progress as Record<string, unknown>)
      : null;
  const lastHeartbeat =
    previewProgress && typeof previewProgress.last_heartbeat === "string" ? previewProgress.last_heartbeat : null;

  return {
    ok: true,
    job_id: input.jobId,
    job_status,
    stage: String(job.stage_label ?? ""),
    percent: typeof job.progress_pct === "number" ? job.progress_pct : 0,
    rows_total: rowsTotal,
    rows_processed: rowsProcessed,
    current_sheet: scan?.sheet ?? applyCur?.sheet ?? null,
    current_chunk_start: typeof scan?.data_row === "number" ? scan.data_row : null,
    current_chunk_end: null,
    lifecycle,
    preview_status: previewStatus || null,
    pim_import_confirmed: Boolean(meta.pim_import_confirmed),
    quality: publicQuality,
    preview_quality: quality,
    mapping: pr?.mapping ?? job.pim_column_map ?? null,
    errors: Array.isArray(pr?.errors) ? pr.errors : [],
    last_error: typeof job.last_error === "string" ? job.last_error : null,
    last_step_at: typeof job.last_step_at === "string" ? job.last_step_at : null,
    retry_count: typeof job.retry_count === "number" ? job.retry_count : 0,
    preview_progress: previewProgress,
    last_heartbeat: lastHeartbeat,
  };
}
