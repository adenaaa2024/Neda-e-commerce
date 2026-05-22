/**
 * `raw_report_uploads.metadata.source_run` control plane (IMPORT-API-02 v1).
 */

import { createHash, randomUUID } from "node:crypto";

import { mergeUploadMetadata, type RawReportUploadMetadata } from "../raw-report-upload-metadata";
import { SP_API_REPORT_TYPE_SETTLEMENT_V2 } from "./reports-api-settlement-plan";

export const SP_API_REPORT_TYPE_REIMBURSEMENTS = "GET_FBA_REIMBURSEMENTS_DATA" as const;

export const SOURCE_RUN_PROVIDER = "amazon_sp_api" as const;
export const SOURCE_RUN_OPERATION = "reports.create_and_download" as const;

export type SourceRunState =
  | "requested"
  | "polling"
  | "downloading"
  | "archived"
  | "synthetic_upload_ready"
  | "staging"
  | "syncing"
  | "generic"
  | "complete"
  | "failed";

export type SourceRunAttempt = {
  count: number;
  last_error_code: string | null;
  /** Sanitized Amazon response snippet — never credentials. */
  last_error_detail?: string | null;
  next_retry_at: string | null;
};

export type SourceRunArchive = {
  object_key: string | null;
  sha256: string | null;
  byte_length: number | null;
  content_type: string | null;
};

export type SourceRunExternalIds = {
  report_id?: string | null;
  report_document_id?: string | null;
  sp_api_request_id?: string | null;
};

export type SourceRunWindow = {
  start: string;
  end: string;
};

export type SourceRunV1 = {
  source_run_id: string;
  parent_source_run_id: string | null;
  provider: typeof SOURCE_RUN_PROVIDER;
  operation: string;
  report_type: string;
  idempotency_key: string;
  external_ids: SourceRunExternalIds;
  marketplace_ids: string[];
  store_id: string | null;
  window: SourceRunWindow | null;
  state: SourceRunState;
  attempt: SourceRunAttempt;
  archive: SourceRunArchive;
  updated_at: string;
};

export function emptySourceRunArchive(): SourceRunArchive {
  return { object_key: null, sha256: null, byte_length: null, content_type: null };
}

export function emptySourceRunAttempt(): SourceRunAttempt {
  return { count: 0, last_error_code: null, last_error_detail: null, next_retry_at: null };
}

export function buildReportsApiIdempotencyKey(parts: {
  organizationId: string;
  storeId: string;
  windowStart: string;
  windowEnd: string;
  marketplaceIds: string[];
  reportType: string;
  operation: string;
}): string {
  const mids = [...parts.marketplaceIds].map((s) => s.trim()).filter(Boolean).sort();
  const payload = [
    parts.organizationId.trim(),
    `provider=${SOURCE_RUN_PROVIDER}`,
    `operation=${parts.operation.trim()}`,
    `report_type=${parts.reportType.trim()}`,
    "finances_api_version=n/a",
    parts.windowStart.trim(),
    parts.windowEnd.trim(),
    mids.join(","),
    parts.storeId.trim(),
  ].join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function buildReimbursementsIdempotencyKey(parts: {
  organizationId: string;
  storeId: string;
  windowStart: string;
  windowEnd: string;
  marketplaceIds: string[];
}): string {
  return buildReportsApiIdempotencyKey({
    ...parts,
    reportType: SP_API_REPORT_TYPE_REIMBURSEMENTS,
    operation: SOURCE_RUN_OPERATION,
  });
}

export function buildSettlementIdempotencyKey(parts: {
  organizationId: string;
  storeId: string;
  windowStart: string;
  windowEnd: string;
  marketplaceIds: string[];
}): string {
  return buildReportsApiIdempotencyKey({
    ...parts,
    reportType: SP_API_REPORT_TYPE_SETTLEMENT_V2,
    operation: "reports.create_and_download.settlement_v2",
  });
}

export function createInitialSourceRun(input: {
  organizationId: string;
  storeId: string;
  marketplaceIds: string[];
  window: SourceRunWindow;
  idempotencyKey: string;
  sourceRunId?: string;
  reportType?: string;
  operation?: string;
}): SourceRunV1 {
  const now = new Date().toISOString();
  return {
    source_run_id: input.sourceRunId ?? randomUUID(),
    parent_source_run_id: null,
    provider: SOURCE_RUN_PROVIDER,
    operation: input.operation ?? SOURCE_RUN_OPERATION,
    report_type: input.reportType ?? SP_API_REPORT_TYPE_REIMBURSEMENTS,
    idempotency_key: input.idempotencyKey,
    external_ids: {},
    marketplace_ids: input.marketplaceIds,
    store_id: input.storeId,
    window: input.window,
    state: "requested",
    attempt: emptySourceRunAttempt(),
    archive: emptySourceRunArchive(),
    updated_at: now,
  };
}

export function parseSourceRun(metadata: unknown): SourceRunV1 | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as unknown as Record<string, unknown>).source_run;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as unknown as Record<string, unknown>;
  const source_run_id = typeof o.source_run_id === "string" ? o.source_run_id.trim() : "";
  if (!source_run_id) return null;
  const state = typeof o.state === "string" ? (o.state as SourceRunState) : "requested";
  const attemptRaw = o.attempt;
  const attempt: SourceRunAttempt =
    attemptRaw && typeof attemptRaw === "object" && !Array.isArray(attemptRaw)
      ? {
          count: Number((attemptRaw as { count?: unknown }).count) || 0,
          last_error_code:
            typeof (attemptRaw as { last_error_code?: unknown }).last_error_code === "string"
              ? (attemptRaw as { last_error_code: string }).last_error_code
              : null,
          last_error_detail:
            typeof (attemptRaw as { last_error_detail?: unknown }).last_error_detail === "string"
              ? (attemptRaw as { last_error_detail: string }).last_error_detail
              : null,
          next_retry_at:
            typeof (attemptRaw as { next_retry_at?: unknown }).next_retry_at === "string"
              ? (attemptRaw as { next_retry_at: string }).next_retry_at
              : null,
        }
      : emptySourceRunAttempt();
  const archiveRaw = o.archive;
  const archive: SourceRunArchive =
    archiveRaw && typeof archiveRaw === "object" && !Array.isArray(archiveRaw)
      ? {
          object_key:
            typeof (archiveRaw as { object_key?: unknown }).object_key === "string"
              ? (archiveRaw as { object_key: string }).object_key
              : null,
          sha256:
            typeof (archiveRaw as { sha256?: unknown }).sha256 === "string"
              ? (archiveRaw as { sha256: string }).sha256
              : null,
          byte_length:
            typeof (archiveRaw as { byte_length?: unknown }).byte_length === "number"
              ? (archiveRaw as { byte_length: number }).byte_length
              : null,
          content_type:
            typeof (archiveRaw as { content_type?: unknown }).content_type === "string"
              ? (archiveRaw as { content_type: string }).content_type
              : null,
        }
      : emptySourceRunArchive();
  const extRaw = o.external_ids;
  const external_ids: SourceRunExternalIds =
    extRaw && typeof extRaw === "object" && !Array.isArray(extRaw)
      ? (extRaw as SourceRunExternalIds)
      : {};
  const marketplace_ids = Array.isArray(o.marketplace_ids)
    ? o.marketplace_ids.filter((x): x is string => typeof x === "string")
    : [];
  const windowRaw = o.window;
  const window: SourceRunWindow | null =
    windowRaw && typeof windowRaw === "object" && !Array.isArray(windowRaw)
      ? {
          start: String((windowRaw as { start?: unknown }).start ?? ""),
          end: String((windowRaw as { end?: unknown }).end ?? ""),
        }
      : null;
  return {
    source_run_id,
    parent_source_run_id:
      typeof o.parent_source_run_id === "string" ? o.parent_source_run_id : null,
    provider: SOURCE_RUN_PROVIDER,
    operation: SOURCE_RUN_OPERATION,
    report_type:
      typeof o.report_type === "string" ? o.report_type : SP_API_REPORT_TYPE_REIMBURSEMENTS,
    idempotency_key: typeof o.idempotency_key === "string" ? o.idempotency_key : "",
    external_ids,
    marketplace_ids,
    store_id: typeof o.store_id === "string" ? o.store_id : null,
    window,
    state,
    attempt,
    archive,
    updated_at: typeof o.updated_at === "string" ? o.updated_at : new Date().toISOString(),
  };
}

export function patchSourceRun(
  prev: SourceRunV1,
  patch: Partial<
    Omit<SourceRunV1, "source_run_id" | "provider" | "operation"> & {
      external_ids?: Partial<SourceRunExternalIds>;
      attempt?: Partial<SourceRunAttempt>;
      archive?: Partial<SourceRunArchive>;
    }
  >,
): SourceRunV1 {
  return {
    ...prev,
    ...patch,
    external_ids: { ...prev.external_ids, ...(patch.external_ids ?? {}) },
    attempt: { ...prev.attempt, ...(patch.attempt ?? {}) },
    archive: { ...prev.archive, ...(patch.archive ?? {}) },
    updated_at: new Date().toISOString(),
  };
}

export function mergeSourceRunIntoMetadata(
  metadata: unknown,
  sourceRun: SourceRunV1,
): RawReportUploadMetadata {
  return mergeUploadMetadata(metadata, {
    source_run: sourceRun,
  } as Partial<RawReportUploadMetadata>);
}

export function isTerminalSourceRunState(state: SourceRunState): boolean {
  return state === "complete" || state === "failed";
}

export function sourceRunNeedsResume(state: SourceRunState): boolean {
  return state === "requested" || state === "polling" || state === "downloading";
}

export function sourceRunNeedsPipeline(state: SourceRunState): boolean {
  return (
    state === "synthetic_upload_ready" ||
    state === "staging" ||
    state === "syncing" ||
    state === "generic"
  );
}
