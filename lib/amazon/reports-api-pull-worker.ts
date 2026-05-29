import "server-only";

import type { ReportsApiClient } from "./reports-api-client";
import { isReportsApiAuthError, isReportsApiThrottleError, ReportsApiError } from "./reports-api-client";
import { resolveReportsApiContext } from "./reports-api-credentials";
import { assessReportsApiPipelineCompletion } from "./reports-api-pipeline-completion";
import { runReportsApiImportPipeline } from "./reports-api-pipeline-handoff";
import {
  buildReportsApiIdempotencyKey,
  createInitialSourceRun,
  isTerminalSourceRunState,
  mergeSourceRunIntoMetadata,
  parseSourceRun,
  patchSourceRun,
  sourceRunNeedsPipeline,
  sourceRunNeedsResume,
  type SourceRunV1,
  type SourceRunWindow,
} from "./reports-api-source-run";
import {
  createReportsApiPlaceholderUpload,
  decompressReportDocument,
  finalizeSyntheticUploadForPipeline,
  findUploadBySourceRunIdempotencyKey,
  parseCsvHeadersFromText,
  sha256Hex,
  writeSyntheticReportBytes,
} from "./reports-api-synthetic-upload";
import {
  pickSettlementReportFromList,
  sanitizeAmazonReportsErrorDetail,
} from "./reports-api-report-request";
import type { ReportsApiPullProfile } from "./reports-api-worker-profile";
import { supabaseServer } from "../supabase-server";
import { isUuidString } from "../uuid";

export const REPORTS_API_REQUEST_BUDGET_MS = 25_000;
export const REPORTS_API_MAX_ATTEMPTS = 3;

export type ReportsApiPullRequest = {
  organizationId: string;
  storeId: string;
  windowStart: string;
  windowEnd: string;
  actorUserId?: string | null;
  uploadId?: string | null;
};

export type ReportsApiPullResult = {
  ok: boolean;
  httpStatus: number;
  upload_id: string | null;
  source_run_id: string | null;
  state: string | null;
  needs_resume: boolean;
  error?: string;
  error_code?: string;
  idempotent_replay?: boolean;
};

export type ReportsApiPullWorkerDeps = {
  profile: ReportsApiPullProfile;
  client?: ReportsApiClient;
  marketplaceIds?: string[];
  runPipeline?: boolean;
  requestBudgetMs?: number;
  now?: () => number;
};

async function loadUploadRow(uploadId: string, organizationId: string) {
  return supabaseServer
    .from("raw_report_uploads")
    .select("id, organization_id, metadata, file_name, status")
    .eq("id", uploadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
}

async function persistSourceRun(
  uploadId: string,
  organizationId: string,
  sourceRun: SourceRunV1,
): Promise<void> {
  const { data: row } = await loadUploadRow(uploadId, organizationId);
  const metadata = mergeSourceRunIntoMetadata(row?.metadata, sourceRun);
  await supabaseServer
    .from("raw_report_uploads")
    .update({ metadata })
    .eq("id", uploadId)
    .eq("organization_id", organizationId);
}

function scheduleRetryIso(attempt: number): string {
  const delaySec = Math.min(120, 15 * 2 ** Math.max(0, attempt - 1));
  return new Date(Date.now() + delaySec * 1000).toISOString();
}

function amazonErrorDetail(err: unknown): string | null {
  if (err instanceof ReportsApiError) return err.detail || null;
  if (err instanceof Error) return sanitizeAmazonReportsErrorDetail(err.message);
  return null;
}

async function acquireReportIdForProfile(
  client: ReportsApiClient,
  profile: ReportsApiPullProfile,
  marketplaceIds: string[],
  window: SourceRunWindow,
): Promise<string> {
  if (profile.acquisitionMode === "scheduled_list") {
    let nextToken: string | null = null;
    let picked = null;
    for (let page = 0; page < 5; page++) {
      const listed = await client.listSettlementReportsInWindow({
        marketplaceIds,
        windowStart: window.start,
        windowEnd: window.end,
        nextToken,
      });
      picked = pickSettlementReportFromList(listed.reports, profile.spReportType);
      if (picked) return picked.reportId;
      nextToken = listed.nextToken;
      if (!nextToken) break;
    }
    throw new ReportsApiError(
      "settlement_report_not_found",
      404,
      `No ${profile.spReportType} report in window ${window.start}..${window.end}`,
    );
  }

  const created = await client.createReport({
    reportType: profile.spReportType,
    marketplaceIds,
    dataStartTime: window.start,
    dataEndTime: window.end,
  });
  return created.reportId;
}

export async function runReportsApiPullWorker(
  req: ReportsApiPullRequest,
  deps: ReportsApiPullWorkerDeps,
): Promise<ReportsApiPullResult> {
  const profile = deps.profile;
  const now = deps.now ?? (() => Date.now());
  const budgetMs = deps.requestBudgetMs ?? REPORTS_API_REQUEST_BUDGET_MS;
  const started = now();
  const runPipeline = deps.runPipeline !== false;

  if (!isUuidString(req.organizationId) || !isUuidString(req.storeId)) {
    return {
      ok: false,
      httpStatus: 400,
      upload_id: null,
      source_run_id: null,
      state: null,
      needs_resume: false,
      error: "organization_id and store_id must be valid UUIDs.",
      error_code: "invalid_input",
    };
  }

  const window: SourceRunWindow = {
    start: req.windowStart.trim(),
    end: req.windowEnd.trim(),
  };
  if (!window.start || !window.end) {
    return {
      ok: false,
      httpStatus: 400,
      upload_id: null,
      source_run_id: null,
      state: null,
      needs_resume: false,
      error: "windowStart and windowEnd are required (ISO8601).",
      error_code: "invalid_window",
    };
  }

  let client = deps.client;
  let marketplaceIds: string[] = [];

  if (!client) {
    const ctxRes = await resolveReportsApiContext(req.organizationId, req.storeId);
    if (!ctxRes.ok) {
      return {
        ok: false,
        httpStatus: 422,
        upload_id: null,
        source_run_id: null,
        state: null,
        needs_resume: false,
        error: ctxRes.error,
        error_code: "credentials_missing",
      };
    }
    marketplaceIds = ctxRes.context.marketplaceIds;
    const { ReportsApiClient: Client } = await import("./reports-api-client");
    client = new Client({ context: ctxRes.context });
  } else {
    marketplaceIds = deps.marketplaceIds?.length ? deps.marketplaceIds : ["ATVPDKIKX0DER"];
  }

  const idempotencyKey = buildReportsApiIdempotencyKey({
    organizationId: req.organizationId,
    storeId: req.storeId,
    windowStart: window.start,
    windowEnd: window.end,
    marketplaceIds: marketplaceIds.length ? marketplaceIds : ["ATVPDKIKX0DER"],
    reportType: profile.spReportType,
    operation: profile.sourceRunOperation,
  });

  let uploadId = req.uploadId?.trim() ?? "";
  let sourceRun: SourceRunV1 | null = null;
  let storagePrefix: string | null = null;
  let idempotentReplay = false;

  if (uploadId && isUuidString(uploadId)) {
    const row = await loadUploadRow(uploadId, req.organizationId);
    if (!row.data) {
      return {
        ok: false,
        httpStatus: 404,
        upload_id: uploadId,
        source_run_id: null,
        state: null,
        needs_resume: false,
        error: "Upload not found.",
        error_code: "upload_not_found",
      };
    }
    sourceRun = parseSourceRun(row.data.metadata);
    const meta = row.data.metadata as unknown as Record<string, unknown> | null;
    storagePrefix = typeof meta?.storage_prefix === "string" ? meta.storage_prefix : null;
  } else {
    const existing = await findUploadBySourceRunIdempotencyKey(
      req.organizationId,
      idempotencyKey,
      profile.uploadReportType,
    );
    if (existing?.sourceRun) {
      const prior = parseSourceRun({ source_run: existing.sourceRun });
      if (prior?.state === "complete") {
        const completion = await assessReportsApiPipelineCompletion(
          supabaseServer,
          req.organizationId,
          existing.uploadId,
          profile.uploadReportType,
        );
        if (!completion.needs_domain_sync) {
          return {
            ok: true,
            httpStatus: 200,
            upload_id: existing.uploadId,
            source_run_id: prior.source_run_id,
            state: "complete",
            needs_resume: false,
            idempotent_replay: true,
          };
        }
        uploadId = existing.uploadId;
        sourceRun = patchSourceRun(prior, { state: "syncing" });
        await persistSourceRun(uploadId, req.organizationId, sourceRun);
        idempotentReplay = false;
      }
      if (prior && !isTerminalSourceRunState(prior.state)) {
        uploadId = existing.uploadId;
        sourceRun = prior;
      }
    }
  }

  if (!sourceRun) {
    sourceRun = createInitialSourceRun({
      organizationId: req.organizationId,
      storeId: req.storeId,
      marketplaceIds: marketplaceIds.length ? marketplaceIds : ["ATVPDKIKX0DER"],
      window,
      idempotencyKey,
      reportType: profile.spReportType,
      operation: profile.sourceRunOperation,
    });
  }

  if (!uploadId) {
    const fileName = profile.syntheticFileName(sourceRun.external_ids.report_document_id ?? null);
    const created = await createReportsApiPlaceholderUpload({
      organizationId: req.organizationId,
      storeId: req.storeId,
      sourceRun,
      fileName,
      uploadReportType: profile.uploadReportType,
      importDescriptorId: profile.importDescriptorId,
      actorUserId: req.actorUserId,
    });
    if (!created.ok) {
      return {
        ok: false,
        httpStatus: 500,
        upload_id: null,
        source_run_id: sourceRun.source_run_id,
        state: "failed",
        needs_resume: false,
        error: created.error,
        error_code: "synthetic_upload_failed",
      };
    }
    uploadId = created.uploadId;
    storagePrefix = created.storagePrefix;
    sourceRun = patchSourceRun(sourceRun, { store_id: req.storeId, marketplace_ids: marketplaceIds });
    await persistSourceRun(uploadId, req.organizationId, sourceRun);
  }

  let needsResume = false;
  let lastError: string | undefined;
  let lastErrorCode: string | undefined;

  while (now() - started < budgetMs) {
    if (isTerminalSourceRunState(sourceRun.state)) break;

    try {
      if (sourceRun.state === "requested") {
        if (!sourceRun.external_ids.report_id) {
          const mids = sourceRun.marketplace_ids.length ? sourceRun.marketplace_ids : marketplaceIds;
          const reportId = await acquireReportIdForProfile(client, profile, mids, window);
          sourceRun = patchSourceRun(sourceRun, {
            state: "polling",
            external_ids: { report_id: reportId },
          });
        } else {
          sourceRun = patchSourceRun(sourceRun, { state: "polling" });
        }
        await persistSourceRun(uploadId, req.organizationId, sourceRun);
        continue;
      }

      if (sourceRun.state === "polling") {
        const reportId = sourceRun.external_ids.report_id;
        if (!reportId) {
          sourceRun = patchSourceRun(sourceRun, { state: "requested" });
          continue;
        }
        const report = await client.getReport(reportId);
        if (report.processingStatus === "DONE") {
          sourceRun = patchSourceRun(sourceRun, {
            state: "downloading",
            external_ids: {
              report_document_id: report.reportDocumentId ?? undefined,
            },
          });
        } else if (report.processingStatus === "FATAL" || report.processingStatus === "CANCELLED") {
          sourceRun = patchSourceRun(sourceRun, {
            state: "failed",
            attempt: {
              count: sourceRun.attempt.count + 1,
              last_error_code: "report_fatal",
              last_error_detail: sanitizeAmazonReportsErrorDetail(
                `processingStatus=${report.processingStatus}`,
              ),
              next_retry_at: null,
            },
          });
        } else {
          needsResume = true;
          sourceRun = patchSourceRun(sourceRun, {
            attempt: {
              ...sourceRun.attempt,
              next_retry_at: scheduleRetryIso(sourceRun.attempt.count + 1),
            },
          });
        }
        await persistSourceRun(uploadId, req.organizationId, sourceRun);
        if (needsResume && sourceRun.state === "polling") break;
        continue;
      }

      if (sourceRun.state === "downloading") {
        const docId =
          sourceRun.external_ids.report_document_id ??
          (sourceRun.external_ids.report_id
            ? (await client.getReport(sourceRun.external_ids.report_id)).reportDocumentId
            : null);
        if (!docId) {
          sourceRun = patchSourceRun(sourceRun, {
            state: "failed",
            attempt: {
              count: sourceRun.attempt.count + 1,
              last_error_code: "download_failed",
              next_retry_at: null,
            },
          });
          await persistSourceRun(uploadId, req.organizationId, sourceRun);
          break;
        }
        const doc = await client.getReportDocument(docId);
        const rawBuf = await client.downloadReportDocument(doc.url);
        const plain = decompressReportDocument(rawBuf, doc.compressionAlgorithm);
        if (plain.length === 0) {
          sourceRun = patchSourceRun(sourceRun, {
            state: "failed",
            attempt: {
              count: sourceRun.attempt.count + 1,
              last_error_code: "download_failed",
              next_retry_at: null,
            },
          });
          await persistSourceRun(uploadId, req.organizationId, sourceRun);
          break;
        }
        const sha = sha256Hex(plain);
        if (!storagePrefix) {
          const row = await loadUploadRow(uploadId, req.organizationId);
          const meta = row.data?.metadata as unknown as Record<string, unknown> | null;
          storagePrefix = typeof meta?.storage_prefix === "string" ? meta.storage_prefix : null;
        }
        if (!storagePrefix) {
          lastError = "Missing storage_prefix on upload.";
          lastErrorCode = "archive_write_failed";
          sourceRun = patchSourceRun(sourceRun, {
            state: "failed",
            attempt: { count: sourceRun.attempt.count + 1, last_error_code: "archive_write_failed", next_retry_at: null },
          });
          await persistSourceRun(uploadId, req.organizationId, sourceRun);
          break;
        }
        const wrote = await writeSyntheticReportBytes({
          storagePrefix,
          bytes: plain,
        });
        if (!wrote.ok) {
          sourceRun = patchSourceRun(sourceRun, {
            state: "failed",
            attempt: {
              count: sourceRun.attempt.count + 1,
              last_error_code: "archive_write_failed",
              next_retry_at: null,
            },
          });
          await persistSourceRun(uploadId, req.organizationId, sourceRun);
          lastError = wrote.error;
          lastErrorCode = "archive_write_failed";
          break;
        }
        const headers = parseCsvHeadersFromText(plain.toString("utf8"));
        const fileName = profile.syntheticFileName(doc.reportDocumentId);
        sourceRun = patchSourceRun(sourceRun, {
          state: "archived",
          external_ids: { report_document_id: doc.reportDocumentId },
          archive: {
            object_key: wrote.objectKey,
            sha256: sha,
            byte_length: plain.length,
            content_type: "text/tab-separated-values",
          },
        });
        await persistSourceRun(uploadId, req.organizationId, sourceRun);

        sourceRun = patchSourceRun(sourceRun, { state: "synthetic_upload_ready" });
        const fin = await finalizeSyntheticUploadForPipeline({
          uploadId,
          organizationId: req.organizationId,
          sourceRun,
          contentSha256: sha,
          byteLength: plain.length,
          csvHeaders: headers,
          fileName,
        });
        if (!fin.ok) {
          sourceRun = patchSourceRun(sourceRun, {
            state: "failed",
            attempt: {
              count: sourceRun.attempt.count + 1,
              last_error_code: "synthetic_upload_failed",
              next_retry_at: null,
            },
          });
          await persistSourceRun(uploadId, req.organizationId, sourceRun);
          lastError = fin.error;
          lastErrorCode = "synthetic_upload_failed";
          break;
        }
        await persistSourceRun(uploadId, req.organizationId, sourceRun);
        continue;
      }

      if (sourceRunNeedsPipeline(sourceRun.state) && runPipeline) {
        const pipe = await runReportsApiImportPipeline({
          uploadId,
          organizationId: req.organizationId,
          sourceRun,
          importFullFile: true,
        });
        sourceRun =
          parseSourceRun((await loadUploadRow(uploadId, req.organizationId)).data?.metadata) ?? sourceRun;
        if (!pipe.ok) {
          lastError = pipe.error;
          lastErrorCode = pipe.error_code;
          break;
        }
        if (pipe.state === "complete") {
          sourceRun = patchSourceRun(sourceRun, { state: "complete" });
          await persistSourceRun(uploadId, req.organizationId, sourceRun);
        }
        continue;
      }

      if (sourceRun.state === "synthetic_upload_ready" && !runPipeline) {
        needsResume = true;
        break;
      }

      break;
    } catch (e) {
      const auth = isReportsApiAuthError(e);
      const throttle = isReportsApiThrottleError(e);
      const code = auth
        ? "sp_api_auth_failed"
        : throttle
          ? "sp_api_throttled"
          : e instanceof ReportsApiError
            ? e.code
            : "unknown";
      const nextCount = sourceRun.attempt.count + 1;
      const errDetail = amazonErrorDetail(e);
      if (auth || nextCount >= REPORTS_API_MAX_ATTEMPTS) {
        sourceRun = patchSourceRun(sourceRun, {
          state: "failed",
          attempt: {
            count: nextCount,
            last_error_code: code,
            last_error_detail: errDetail,
            next_retry_at: null,
          },
        });
        await persistSourceRun(uploadId, req.organizationId, sourceRun);
        lastError = e instanceof Error ? e.message : String(e);
        lastErrorCode = code;
        break;
      }
      sourceRun = patchSourceRun(sourceRun, {
        attempt: {
          count: nextCount,
          last_error_code: code,
          last_error_detail: errDetail,
          next_retry_at: scheduleRetryIso(nextCount),
        },
      });
      await persistSourceRun(uploadId, req.organizationId, sourceRun);
      needsResume = true;
      lastError = e instanceof Error ? e.message : String(e);
      lastErrorCode = code;
      break;
    }
  }

  if (!isTerminalSourceRunState(sourceRun.state) && sourceRunNeedsResume(sourceRun.state)) {
    needsResume = true;
  }

  return {
    ok: sourceRun.state === "complete",
    httpStatus:
      sourceRun.state === "complete" ? 200 : needsResume ? 202 : sourceRun.state === "failed" ? 500 : 202,
    upload_id: uploadId,
    source_run_id: sourceRun.source_run_id,
    state: sourceRun.state,
    needs_resume: needsResume,
    error: lastError,
    error_code: lastErrorCode,
    idempotent_replay: idempotentReplay,
  };
}
