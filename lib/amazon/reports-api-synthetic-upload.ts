import "server-only";

import { randomUUID } from "node:crypto";

import {
  buildImportUploadDescriptorMetadataFromDescriptorId,
  isImportDescriptorMetadataEnabled,
  mergeImportDescriptorIntoUploadMetadata,
} from "../import/import-upload-descriptor-metadata";
import { mergeUploadMetadata } from "../raw-report-upload-metadata";
import { supabaseServer } from "../supabase-server";
import { isUuidString } from "../uuid";
import type { SourceRunV1 } from "./reports-api-source-run";
import { mergeSourceRunIntoMetadata } from "./reports-api-source-run";
import { md5HexFromSha256Prefix } from "./reports-api-document-utils";
import type { ReportsApiUploadReportType } from "./reports-api-worker-profile";

export {
  decompressReportDocument,
  md5HexFromSha256Prefix,
  parseCsvHeadersFromText,
  sha256Hex,
} from "./reports-api-document-utils";

export const RAW_REPORTS_BUCKET = "raw-reports";

export async function findUploadBySourceRunIdempotencyKey(
  organizationId: string,
  idempotencyKey: string,
  uploadReportType: ReportsApiUploadReportType = "REIMBURSEMENTS",
): Promise<{ uploadId: string; sourceRun: SourceRunV1 | null; contentSha256: string | null } | null> {
  const { data, error } = await supabaseServer
    .from("raw_report_uploads")
    .select("id, metadata, status")
    .eq("organization_id", organizationId)
    .eq("report_type", uploadReportType)
    .order("created_at", { ascending: false })
    .limit(40);

  if (error || !data?.length) return null;

  for (const row of data) {
    const meta = row.metadata as unknown as Record<string, unknown> | null;
    const sr = meta?.source_run as unknown as Record<string, unknown> | undefined;
    if (!sr || typeof sr !== "object") continue;
    if (String(sr.idempotency_key ?? "") !== idempotencyKey) continue;
    const uploadId = String(row.id ?? "");
    if (!isUuidString(uploadId)) continue;
    const sha =
      typeof meta?.content_sha256 === "string" ? meta.content_sha256.trim().toLowerCase() : null;
    return { uploadId, sourceRun: sr as unknown as SourceRunV1, contentSha256: sha };
  }
  return null;
}

export async function createReportsApiPlaceholderUpload(params: {
  organizationId: string;
  storeId: string;
  sourceRun: SourceRunV1;
  fileName: string;
  uploadReportType: ReportsApiUploadReportType;
  importDescriptorId: string;
  actorUserId?: string | null;
}): Promise<{ ok: true; uploadId: string; storagePrefix: string } | { ok: false; error: string }> {
  const storagePrefix = `${params.organizationId}/reports-api-${Date.now()}-${randomUUID().slice(0, 8)}`;
  let metadata = mergeSourceRunIntoMetadata(null, params.sourceRun);
  metadata = mergeUploadMetadata(metadata, {
    storage_prefix: storagePrefix,
    upload_chunks_count: 1,
    total_parts: 1,
    import_store_id: params.storeId,
    ledger_store_id: params.storeId,
    file_name: params.fileName,
    file_extension: "tsv",
    upload_progress: 0,
    uploaded_bytes: 0,
    process_progress: 0,
    source: "amazon_reports_api",
  });
  if (isImportDescriptorMetadataEnabled()) {
    const desc = buildImportUploadDescriptorMetadataFromDescriptorId(params.importDescriptorId);
    metadata = mergeImportDescriptorIntoUploadMetadata(metadata, desc);
  }

  const insertRow: Record<string, unknown> = {
    organization_id: params.organizationId,
    file_name: params.fileName,
    report_type: params.uploadReportType,
    status: "uploading",
    column_mapping: null,
    metadata,
    ...(params.actorUserId && isUuidString(params.actorUserId) ? { created_by: params.actorUserId } : {}),
  };

  const { data, error } = await supabaseServer
    .from("raw_report_uploads")
    .insert(insertRow)
    .select("id")
    .single();

  if (error || !data?.id) {
    return { ok: false, error: error?.message ?? "Could not create upload row." };
  }
  return { ok: true, uploadId: String(data.id), storagePrefix };
}

export async function writeSyntheticReportBytes(params: {
  storagePrefix: string;
  bytes: Buffer;
  contentType?: string;
}): Promise<{ ok: true; objectKey: string } | { ok: false; error: string }> {
  const objectKey = `${params.storagePrefix}/part-000000`;
  const { error } = await supabaseServer.storage.from(RAW_REPORTS_BUCKET).upload(objectKey, params.bytes, {
    contentType: params.contentType ?? "text/tab-separated-values; charset=utf-8",
    upsert: true,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, objectKey };
}

export async function finalizeSyntheticUploadForPipeline(params: {
  uploadId: string;
  organizationId: string;
  sourceRun: SourceRunV1;
  contentSha256: string;
  byteLength: number;
  csvHeaders: string[];
  fileName: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: row, error: fetchErr } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata")
    .eq("id", params.uploadId)
    .eq("organization_id", params.organizationId)
    .maybeSingle();
  if (fetchErr || !row) return { ok: false, error: "Upload row not found." };

  const md5 = md5HexFromSha256Prefix(params.contentSha256);
  let metadata = mergeSourceRunIntoMetadata(row.metadata, params.sourceRun);
  metadata = mergeUploadMetadata(metadata, {
    content_sha256: params.contentSha256,
    md5_hash: md5,
    file_size_bytes: params.byteLength,
    total_bytes: params.byteLength,
    uploaded_bytes: params.byteLength,
    upload_progress: 100,
    csv_headers: params.csvHeaders,
    file_name: params.fileName,
    import_metrics: { current_phase: "upload" },
  });

  const { error } = await supabaseServer
    .from("raw_report_uploads")
    .update({
      status: "mapped",
      metadata,
      file_name: params.fileName,
    })
    .eq("id", params.uploadId)
    .eq("organization_id", params.organizationId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
