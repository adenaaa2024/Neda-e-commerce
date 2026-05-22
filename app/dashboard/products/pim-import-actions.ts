"use server";

import { pimHistoryRowIsTerminal } from "../../../lib/pim-import-history";
import { PIM_RAW_REPORT_TYPES } from "../../../lib/pim-import-report-types";
import { pimEtlPriceBackfillStep, pimEtlRetryPreview } from "../../../lib/pim-import-etl-server";
import { mergeUploadMetadata } from "../../../lib/raw-report-upload-metadata";
import { supabaseServer } from "../../../lib/supabase-server";
import { isUuidString } from "../../../lib/uuid";
import {
  assertUserCanAccessOrganization,
  userCanRunPimPriceBackfill,
  userCanViewPimEnrichmentDebug,
} from "./pim-actions";

/** Canonical Product Master upload type on `raw_report_uploads.report_type` (DB check constraint). */
const PIM_PRODUCT_MASTER_REPORT_TYPE = "pim_product_master";
/** Legacy catalog-seed rows that use the same Product Master UI (optional merge into history). */
const PIM_HISTORY_LEGACY_SEED_TYPES = ["pim_catalog_seed", "PIM_CATALOG_SEED"] as const;

type RawReportUploadListRow = {
  id?: string;
  file_name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  status?: string | null;
  row_count?: number | null;
  metadata?: Record<string, unknown> | null;
  error_message?: string | null;
  report_type?: string | null;
  created_by?: string | null;
};

const RAW_BUCKET = "raw-reports";

/** PIM Quick Import history types — Product Master / catalog seed (`raw_report_uploads` only). */
const PIM_SESSION_REPORT_TYPES = [
  "pim_product_master",
  "pim_catalog_seed",
  "PIM_CATALOG_SEED",
  "product_master",
  "catalog_seed",
] as const;

function uploadStoreIdFromMetadata(m: Record<string, unknown>): string {
  return String(
    m.import_store_id ??
      m.ledger_store_id ??
      m.store_id ??
      m.target_store_id ??
      m.pim_store_id ??
      m.storeId ??
      "",
  ).trim();
}

/** Returns true if the row looks like a PIM upload regardless of report_type. */
function isPimMetadataRow(m: Record<string, unknown>): boolean {
  if (m.pim_catalog_seed === true || m.pim_async_import === true) return true;
  if (String(m.module ?? "").toLowerCase() === "pim") return true;
  if (String(m.import_area ?? "").toLowerCase() === "product_master") return true;
  return false;
}

export type EnsurePimImportSessionsResult = {
  backfilled: number;
  linkedMetadataPatches: number;
  scannedRawUploads: number;
  sessionsForStore: number;
};

export type PimUnlinkedUploadRow = {
  upload_id: string;
  file_name: string;
  created_at: string | null;
  status: string;
  report_type: string | null;
  metadata: Record<string, unknown>;
};

export type PimImportUploadSessionResult =
  | {
      ok: true;
      uploadId: string;
      storagePrefix: string;
      resumed?: boolean;
      skipUpload?: boolean;
      /** Legacy alias — always null without `pim_import_sessions`; UI uses `uploadId`. */
      importSessionId?: string | null;
    }
  | { ok: false; error: string };

export type PimResumableProductMasterRow = {
  id: string;
  file_name: string;
  status: string;
  metadata: Record<string, unknown>;
};

/** Richer restore row returned by findLatestActivePimUpload. */
export type PimActiveUploadRestoreRow = {
  id: string;
  file_name: string;
  status: string;
  updated_at: string | null;
  metadata: Record<string, unknown>;
  /** Derived from metadata */
  lifecycle: string | null;
  preview_status: string | null;
  import_store_id: string | null;
  pim_import_safe_rows_only: boolean;
};

/**
 * Creates a `raw_report_uploads` row for chunked PIM import (metadata.storage_prefix for /api/settings/imports/chunk).
 * Does not parse the workbook — ETL processes via POST /etl/pim-import/preview-step.
 */
export async function createPimImportUploadSession(input: {
  organizationId: string;
  storeId: string;
  fileName: string;
  totalBytes: number;
  fileExtension: string;
  /** Lowercase hex SHA-256 of full file bytes — dedupes sessions per org+store+Product Master. */
  contentSha256?: string | null;
  /**
   * When true and SHA matches an in-flight upload with completed parts, resume that upload row.
   * Default false: always create a new import session row (full history).
   */
  resumeIncompleteBySha?: boolean;
}): Promise<PimImportUploadSessionResult> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };

  const sid = input.storeId.trim();
  if (!isUuidString(sid)) return { ok: false, error: "Invalid store." };

  const shaIn = String(input.contentSha256 ?? "")
    .trim()
    .toLowerCase();
  if (input.resumeIncompleteBySha === true && shaIn && /^[a-f0-9]{64}$/.test(shaIn)) {
    const { data: candidates, error: cErr } = await supabaseServer
      .from("raw_report_uploads")
      .select("id,metadata,status")
      .eq("organization_id", input.organizationId)
      .eq("report_type", "pim_product_master")
      .order("updated_at", { ascending: false })
      .limit(40);
    if (!cErr && candidates?.length) {
      for (const c of candidates) {
        const m = (c as { metadata?: Record<string, unknown> }).metadata ?? {};
        const store = String(m.import_store_id ?? m.ledger_store_id ?? m.store_id ?? "").trim();
        if (store !== sid) continue;
        const rowSha = String(m.content_sha256 ?? "").trim().toLowerCase();
        if (rowSha !== shaIn) continue;
        if (m.pim_import_cancelled === true) continue;
        const job = (m.pim_import_job as unknown as Record<string, unknown> | undefined) ?? {};
        const life = String(job.lifecycle ?? "").toLowerCase();
        if (life === "completed") continue;
        const prefix = typeof m.storage_prefix === "string" ? m.storage_prefix.trim() : "";
        if (!prefix) continue;
        const cid = String((c as { id?: string }).id ?? "").trim();
        if (!isUuidString(cid)) continue;
        const parts = Number(m.total_parts || m.upload_chunks_count || 0);
        const upPct = Number(m.upload_progress ?? 0);
        const rowStatus = String((c as { status?: string }).status ?? "").toLowerCase();
        const skipUpload =
          parts > 0 &&
          upPct >= 99 &&
          (rowStatus === "uploaded" || rowStatus === "processing" || rowStatus === "mapped" || rowStatus === "failed");
        return { ok: true, uploadId: cid, storagePrefix: prefix, resumed: true, skipUpload, importSessionId: null };
      }
    }
  }

  const storagePrefix = `${input.organizationId}/${Date.now()}-pim-${Math.random().toString(36).slice(2, 10)}`;

  const meta = mergeUploadMetadata(null, {
    storage_prefix: storagePrefix,
    import_store_id: sid,
    ledger_store_id: sid,
    total_bytes: input.totalBytes,
    upload_progress: 0,
    uploaded_bytes: 0,
    total_parts: 0,
    upload_chunks_count: 0,
    file_extension: input.fileExtension.replace(/^\./, "").toLowerCase(),
    file_name: input.fileName,
    file_size_bytes: input.totalBytes,
    ...(shaIn && /^[a-f0-9]{64}$/.test(shaIn) ? { content_sha256: shaIn } : {}),
    ...( {
      pim_catalog_seed: true,
      pim_async_import: true,
      module: "pim",
      import_area: "product_master",
      source_kind: "file",
      preview_status: "uploaded",
      confirm_required: true,
      store_id: sid,
      pim_import_job: {
        lifecycle: "uploaded",
        source_type: "file",
        progress_pct: 0,
        stage_label: "uploaded",
      },
    } as unknown as Record<string, unknown>),
  });

  const { data, error } = await supabaseServer
    .from("raw_report_uploads")
    .insert({
      organization_id: input.organizationId,
      file_name: input.fileName,
      report_type: "pim_product_master",
      status: "uploading",
      column_mapping: null,
      metadata: meta,
      created_by: gate.userId,
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    return { ok: false, error: error?.message ?? "Failed to create import session." };
  }

  const uploadId = data.id as string;

  try {
    await supabaseServer.from("file_processing_status").upsert(
      {
        upload_id: uploadId,
        organization_id: input.organizationId,
        status: "uploading",
        current_phase: "upload",
        process_pct: 0,
        upload_pct: 0,
        sync_pct: 0,
        processed_rows: 0,
        total_rows: null,
        file_size_bytes: input.totalBytes,
        uploaded_bytes: 0,
        error_message: null,
      },
      { onConflict: "upload_id" },
    );
  } catch {
    /* optional progress row */
  }

  return { ok: true, uploadId, storagePrefix, resumed: false, skipUpload: false, importSessionId: null };
}

/**
 * After all chunk parts are stored, mark upload complete for ETL to read `total_parts`.
 */
export async function finalizePimImportUploadSession(input: {
  organizationId: string;
  uploadId: string;
  totalParts: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  if (!isUuidString(input.uploadId)) return { ok: false, error: "Invalid upload id." };

  const { data: row, error: fe } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata")
    .eq("id", input.uploadId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (fe || !row) return { ok: false, error: "Upload not found." };

  const prev = (row as { metadata?: unknown }).metadata;
  const meta = mergeUploadMetadata(prev, {
    total_parts: input.totalParts,
    upload_chunks_count: input.totalParts,
    upload_progress: 100,
    uploaded_bytes: (prev as { total_bytes?: number })?.total_bytes,
    preview_status: "previewing",
    ...( {
      pim_import_job: {
        lifecycle: "uploaded",
        stage_label: "queued",
        progress_pct: 10,
      },
    } as unknown as Record<string, unknown>),
  });

  const { error } = await supabaseServer
    .from("raw_report_uploads")
    .update({
      metadata: meta,
      status: "uploaded",
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.uploadId)
    .eq("organization_id", input.organizationId);

  if (error) return { ok: false, error: error.message };

  return { ok: true };
}

/**
 * Find the latest active Product Master upload for the org — does NOT require a storeId.
 * Queries raw_report_uploads directly by organization_id + report_type='pim_product_master'.
 * Returns the newest non-terminal upload so the UI can restore the active card on page load/refresh
 * without depending on selectedStoreId being set first.
 */
export async function findLatestActivePimUpload(input: {
  organizationId: string;
}): Promise<{ ok: true; row: PimActiveUploadRestoreRow | null } | { ok: false; error: string }> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };

  // Statuses considered "active" (non-terminal, restorable)
  const activeRawStatuses = ["uploading", "uploaded", "processing", "mapped", "failed", "cancelled"];

  const { data, error } = await supabaseServer
    .from("raw_report_uploads")
    .select("id,file_name,status,updated_at,metadata,report_type")
    .eq("organization_id", input.organizationId)
    .in("report_type", [...PIM_SESSION_REPORT_TYPES])
    .in("status", activeRawStatuses)
    .order("updated_at", { ascending: false })
    .limit(40);

  if (error) return { ok: false, error: error.message };

  // Terminal lifecycle values — skip these
  const terminalLifecycles = new Set(["completed", "reset"]);
  const terminalPreviewStatuses = new Set(["completed", "reset"]);

  for (const row of data ?? []) {
    const meta = ((row as { metadata?: Record<string, unknown> }).metadata ?? {}) as unknown as Record<string, unknown>;

    // Skip deleted
    if (meta.pim_upload_deleted === true || meta.deleted === true) continue;

    const job = (meta.pim_import_job as unknown as Record<string, unknown> | undefined) ?? {};
    const lifecycle = String(job.lifecycle ?? "").toLowerCase();
    const previewStatus = String(meta.preview_status ?? "").toLowerCase();

    // Skip terminal
    if (terminalLifecycles.has(lifecycle) || terminalPreviewStatuses.has(previewStatus)) continue;
    // Skip explicitly cancelled with no partial writes
    if (lifecycle === "cancelled" && previewStatus === "cancelled") {
      const am = (job.apply_metrics as unknown as Record<string, unknown> | undefined) ?? {};
      const hasWrites = ["products_created", "products_updated", "identifiers_created", "prices_inserted"]
        .some((k) => Number(am[k] ?? 0) > 0);
      if (!hasWrites) continue;
    }

    // This is a live, restorable row
    const id = String((row as { id?: string }).id ?? "").trim();
    if (!isUuidString(id)) continue;

    return {
      ok: true,
      row: {
        id,
        file_name: String((row as { file_name?: string }).file_name ?? "upload"),
        status: String((row as { status?: string }).status ?? ""),
        updated_at: String((row as { updated_at?: string }).updated_at ?? null),
        metadata: meta,
        lifecycle: lifecycle || null,
        preview_status: previewStatus || null,
        import_store_id: uploadStoreIdFromMetadata(meta) || null,
        pim_import_safe_rows_only: meta.pim_import_safe_rows_only === true,
      },
    };
  }

  return { ok: true, row: null };
}

/**
 * Latest Product Master upload for org+store that can be resumed — from {@link listPimImportSessions}.
 */
export async function findResumablePimProductMasterSession(input: {
  organizationId: string;
  storeId: string;
}): Promise<{ ok: true; row: PimResumableProductMasterRow | null } | { ok: false; error: string }> {
  const pick = await pickSuggestedActivePimImport(input);
  if (!pick.ok) return pick;
  return { ok: true, row: pick.row };
}

/**
 * Load persisted PIM preview from `raw_report_uploads.metadata` (tab resume / debug).
 */
export async function fetchPimImportPreviewSnapshot(input: {
  organizationId: string;
  uploadId: string;
}): Promise<
  | {
      ok: true;
      preview_status: string | null;
      row_status: string | null;
      report_type: string | null;
      upload_row_id: string | null;
      updated_at: string | null;
      import_store_id: string | null;
      content_sha256: string | null;
      pim_preview_result: Record<string, unknown> | null;
      preview_quality: Record<string, unknown> | null;
      pim_import_job: Record<string, unknown> | null;
      pim_import_session_id: string | null;
      /** True when this session was originally started as "Import safe rows only". */
      pim_import_safe_rows_only: boolean;
    }
  | { ok: false; error: string }
> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  if (!isUuidString(input.uploadId)) return { ok: false, error: "Invalid upload id." };

  const { data, error } = await supabaseServer
    .from("raw_report_uploads")
    .select("id,metadata,status,report_type,updated_at")
    .eq("id", input.uploadId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (error || !data) return { ok: false, error: error?.message ?? "Upload not found." };
  const row = data as {
    id?: string;
    metadata?: Record<string, unknown>;
    status?: string;
    report_type?: string;
    updated_at?: string;
  };
  const meta = row.metadata ?? {};
  const prRaw = meta.pim_preview_result;
  const pr = typeof prRaw === "object" && prRaw !== null && !Array.isArray(prRaw) ? (prRaw as unknown as Record<string, unknown>) : null;
  const jobRaw = meta.pim_import_job;
  const job =
    typeof jobRaw === "object" && jobRaw !== null && !Array.isArray(jobRaw) ? (jobRaw as unknown as Record<string, unknown>) : null;
  const pqRaw = job?.preview_quality;
  const pq =
    typeof pqRaw === "object" && pqRaw !== null && !Array.isArray(pqRaw) ? (pqRaw as unknown as Record<string, unknown>) : null;
  const fromSnapshot = pr?.raw_quality;
  const fromSnapshotQ =
    typeof fromSnapshot === "object" && fromSnapshot !== null && !Array.isArray(fromSnapshot)
      ? (fromSnapshot as unknown as Record<string, unknown>)
      : null;
  const preview_quality = fromSnapshotQ ?? pq;

  const uploadPk = typeof row.id === "string" ? row.id : null;
  const legacyMetaSid =
    typeof meta.pim_import_session_id === "string" && isUuidString(meta.pim_import_session_id.trim())
      ? meta.pim_import_session_id.trim()
      : null;

  return {
    ok: true,
    preview_status: typeof meta.preview_status === "string" ? meta.preview_status : null,
    row_status: typeof row.status === "string" ? row.status : null,
    report_type: typeof row.report_type === "string" ? row.report_type : null,
    upload_row_id: uploadPk,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    import_store_id:
      typeof meta.import_store_id === "string"
        ? meta.import_store_id
        : typeof meta.store_id === "string"
          ? meta.store_id
          : null,
    content_sha256: typeof meta.content_sha256 === "string" ? meta.content_sha256 : null,
    pim_preview_result: pr,
    preview_quality,
    pim_import_job: job,
    pim_import_safe_rows_only: meta.pim_import_safe_rows_only === true,
    /** Without `pim_import_sessions`, use upload row id for any UI that still expects a session key. */
    pim_import_session_id: legacyMetaSid ?? uploadPk,
  };
}

export async function deletePimImportUploads(input: {
  organizationId: string;
  uploadIds: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  const ids = input.uploadIds.filter((x) => isUuidString(x));
  if (!ids.length) return { ok: false, error: "No valid ids." };

  const { data: rows } = await supabaseServer
    .from("raw_report_uploads")
    .select("id, metadata, report_type")
    .eq("organization_id", input.organizationId)
    .in("id", ids);

  for (const r of rows ?? []) {
    const rt = String((r as { report_type?: string }).report_type ?? "");
    const mod = (r as { metadata?: Record<string, unknown> }).metadata?.module;
    const okPim =
      (PIM_RAW_REPORT_TYPES as readonly string[]).includes(rt) ||
      mod === "pim" ||
      Boolean((r as { metadata?: Record<string, unknown> }).metadata?.pim_catalog_seed);
    if (!okPim) {
      return { ok: false, error: "One or more rows are not PIM import sessions." };
    }
  }

  const paths: string[] = [];
  for (const r of rows ?? []) {
    const m = (r as { metadata?: Record<string, unknown> }).metadata ?? {};
    const p =
      (typeof m.storage_path === "string" && m.storage_path) ||
      (typeof m.raw_file_path === "string" && m.raw_file_path) ||
      (typeof m.pim_merged_storage_path === "string" && m.pim_merged_storage_path);
    if (p) paths.push(p);
    const prefix = typeof m.storage_prefix === "string" ? m.storage_prefix : "";
    const parts = Number(m.total_parts || m.upload_chunks_count || 0);
    if (prefix && parts > 0) {
      for (let i = 0; i < parts; i++) {
        paths.push(`${prefix}/part-${String(i).padStart(6, "0")}`);
      }
    }
    const mergedPath =
      typeof m.pim_merged_storage_path === "string" ? m.pim_merged_storage_path.trim() : "";
    if (mergedPath) paths.push(mergedPath);
    const scanCache =
      typeof m.pim_csv_scan_cache_storage === "string" ? m.pim_csv_scan_cache_storage.trim() : "";
    if (scanCache) paths.push(scanCache);
  }

  if (paths.length) {
    await supabaseServer.storage.from(RAW_BUCKET).remove(paths);
  }

  const { error } = await supabaseServer
    .from("raw_report_uploads")
    .delete()
    .eq("organization_id", input.organizationId)
    .in("id", ids);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** One PIM async import session joined to its upload row (history + resume). */
export type PimImportSessionListRow = {
  session_id: string;
  upload_id: string;
  /** Same as `upload_id` — cancel/preview/apply APIs use this job id. */
  id: string;
  file_name: string;
  status: string;
  session_status: string;
  progress_percent: number;
  current_step: string;
  created_at: string | null;
  updated_at: string | null;
  preview_status: string | null;
  lifecycle: string | null;
  import_mode: string | null;
  row_count: number | null;
  metadata: Record<string, unknown> | null;
  error_message: string | null;
  report_type: string | null;
  created_by: string | null;
  uploader_name: string | null;
  session_last_error: string | null;
  preview_metrics: Record<string, unknown> | null;
  apply_metrics: Record<string, unknown> | null;
  total_rows: number | null;
  processed_rows: number | null;
  accepted_rows: number | null;
  dirty_rows: number | null;
  skipped_rows: number | null;
  ambiguous_rows: number | null;
  conflict_rows: number | null;
  /** True when this row was force-included because it is the active upload but store metadata doesn't match. */
  store_mismatch?: boolean;
};

/** Derive display lifecycle from `raw_report_uploads.metadata` (mirrors ETL job sync). */
function sessionStatusFromUploadMetadata(
  m: Record<string, unknown>,
  uploadRowStatus?: string | null,
): {
  status: string;
  current_step: string;
  progress_percent: number;
} {
  const job = (m.pim_import_job as unknown as Record<string, unknown> | undefined) ?? {};
  const life = String(job.lifecycle ?? "").trim().toLowerCase();
  const pstat = String(m.preview_status ?? "").trim().toLowerCase();
  const stage = String(job.stage_label ?? "").trim();
  const pct = Number(job.progress_pct);
  const progress = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
  const urs = String(uploadRowStatus ?? "").trim().toLowerCase();
  if (urs === "uploading" || urs === "pending" || urs === "processing") {
    return { status: "uploading", current_step: stage || "uploading", progress_percent: progress || 5 };
  }
  if (m.pim_import_cancelled === true || pstat === "cancelled" || life === "cancelled") {
    return { status: "cancelled", current_step: "cancelled", progress_percent: 0 };
  }
  if (life === "completed") {
    return { status: "completed", current_step: stage || "completed", progress_percent: 100 };
  }
  if (life === "failed" || pstat === "failed" || pstat === "import_partial_failed") {
    return { status: "failed", current_step: stage || "failed", progress_percent: progress };
  }
  if (life === "importing" || life === "import_queued") {
    return { status: "importing", current_step: stage || "importing", progress_percent: progress || 5 };
  }
  if (pstat === "preview_ready" || life === "waiting_for_confirmation" || life === "preview_ready") {
    return { status: "preview_ready", current_step: stage || "preview_ready", progress_percent: progress || 100 };
  }
  if (life === "previewing" || pstat === "previewing") {
    return { status: "preview_running", current_step: stage || "scanning_rows", progress_percent: progress || 10 };
  }
  return { status: "uploaded", current_step: stage || "uploaded", progress_percent: progress };
}

function pimListStatsFromRawScan(relevantCount: number): EnsurePimImportSessionsResult {
  return {
    backfilled: 0,
    linkedMetadataPatches: 0,
    scannedRawUploads: relevantCount,
    sessionsForStore: relevantCount,
  };
}

function mapRawReportUploadToHistoryRow(
  up: {
    id?: string;
    file_name?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    status?: string | null;
    row_count?: number | null;
    metadata?: Record<string, unknown> | null;
    error_message?: string | null;
    report_type?: string | null;
    created_by?: string | null;
  },
  nameById: Map<string, string>,
): PimImportSessionListRow | null {
  const uid = String(up.id ?? "").trim();
  if (!isUuidString(uid)) return null;
  const m = (up.metadata && typeof up.metadata === "object" ? up.metadata : {}) as unknown as Record<string, unknown>;
  const job = (m.pim_import_job as unknown as Record<string, unknown> | undefined) ?? {};
  const frozen = job.frozen_plan as unknown as Record<string, unknown> | undefined;
  const importMode =
    (typeof job.import_mode === "string" && job.import_mode.trim()) ||
    (typeof frozen?.import_mode === "string" && String(frozen.import_mode).trim()) ||
    null;
  const ss = sessionStatusFromUploadMetadata(m, up.status);
  const uploadedBy = String(up.created_by ?? "").trim();

  const preview_metrics =
    m.preview_metrics && typeof m.preview_metrics === "object" && !Array.isArray(m.preview_metrics)
      ? (m.preview_metrics as unknown as Record<string, unknown>)
      : null;
  let apply_metrics =
    m.apply_metrics && typeof m.apply_metrics === "object" && !Array.isArray(m.apply_metrics)
      ? (m.apply_metrics as unknown as Record<string, unknown>)
      : null;
  if (!apply_metrics && job.apply_metrics && typeof job.apply_metrics === "object") {
    apply_metrics = job.apply_metrics as unknown as Record<string, unknown>;
  }

  const pq = job.preview_quality;
  const quality =
    typeof pq === "object" && pq !== null && !Array.isArray(pq) ? (pq as unknown as Record<string, unknown>) : null;
  const pm = preview_metrics ?? quality;

  const num = (o: Record<string, unknown> | null, k: string): number | null => {
    if (!o) return null;
    const v = o[k];
    return typeof v === "number" ? v : null;
  };

  const total_rows = num(pm, "rows_total") ?? (typeof up.row_count === "number" ? up.row_count : null);
  const processed_rows = num(pm, "rows_scanned") ?? num(pm, "rows_total");
  const accepted_rows = num(pm, "rows_accepted_estimate") ?? num(pm, "accepted_rows");
  const dirty_rows = num(pm, "dirty_rows") ?? num(pm, "skipped_dirty_row");

  return {
    session_id: uid,
    upload_id: uid,
    id: uid,
    total_rows,
    processed_rows,
    accepted_rows,
    dirty_rows,
    skipped_rows: num(pm, "skipped_rows"),
    ambiguous_rows: num(pm, "ambiguous_rows"),
    conflict_rows: num(pm, "conflict_rows"),
    file_name: String(up.file_name ?? "upload"),
    status: String(up.status ?? ""),
    session_status: ss.status,
    progress_percent: ss.progress_percent,
    current_step: ss.current_step,
    created_at: up.created_at ?? null,
    updated_at: up.updated_at ?? null,
    preview_status: typeof m.preview_status === "string" ? m.preview_status : null,
    lifecycle: typeof job.lifecycle === "string" ? job.lifecycle : null,
    import_mode: importMode,
    row_count: typeof up.row_count === "number" ? up.row_count : null,
    metadata: m,
    error_message: typeof up.error_message === "string" ? up.error_message : null,
    report_type: typeof up.report_type === "string" ? up.report_type : null,
    created_by: uploadedBy && isUuidString(uploadedBy) ? uploadedBy : null,
    uploader_name: uploadedBy && isUuidString(uploadedBy) ? (nameById.get(uploadedBy) ?? null) : null,
    session_last_error:
      typeof job.last_error === "string"
        ? job.last_error
        : typeof m.last_error === "string"
          ? m.last_error
          : null,
    preview_metrics: preview_metrics ?? quality,
    apply_metrics,
  };
}

/** Newest-first history row that can drive “current import” / resume (within loaded history window). */
function isSuggestedActivePimImportRow(row: PimImportSessionListRow): boolean {
  if (pimHistoryRowIsTerminal(row)) return false;
  const m = row.metadata ?? {};
  const p = String(row.preview_status ?? "").toLowerCase();
  const rs = String(row.status ?? "").toLowerCase();
  const job = (m.pim_import_job as unknown as Record<string, unknown> | undefined) ?? {};
  const life = String(job.lifecycle ?? "").toLowerCase();
  const cand = new Set([
    "uploaded",
    "previewing",
    "preview_ready",
    "waiting_for_confirmation",
    "importing",
    "import_queued",
    "import_partial_failed",
    "failed",
    "cancelled",
    "preview_failed",
  ]);
  if (cand.has(p) || cand.has(life) || cand.has(rs)) return true;
  if (life === "waiting_for_confirmation" || life === "preview_ready" || life === "uploaded") return true;
  return false;
}

/** If an in-flight Product Master upload already exists for this file hash + store, prefer reusing it. */
export async function findActivePimImportBySha(input: {
  organizationId: string;
  storeId: string;
  contentSha256: string;
}): Promise<
  | {
      ok: true;
      found: boolean;
      uploadId: string | null;
      importSessionId: string | null;
      fileName: string | null;
      lifecycle: string | null;
      previewStatus: string | null;
    }
  | { ok: false; error: string }
> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  const sid = input.storeId.trim();
  if (!isUuidString(sid)) return { ok: false, error: "Invalid store." };
  const shaIn = String(input.contentSha256 ?? "")
    .trim()
    .toLowerCase();
  if (!shaIn || !/^[a-f0-9]{64}$/.test(shaIn)) {
    return { ok: true, found: false, uploadId: null, importSessionId: null, fileName: null, lifecycle: null, previewStatus: null };
  }

  const { data: candidates, error } = await supabaseServer
    .from("raw_report_uploads")
    .select("id,file_name,metadata")
    .eq("organization_id", input.organizationId)
    .eq("report_type", "pim_product_master")
    .order("updated_at", { ascending: false })
    .limit(60);

  if (error) return { ok: false, error: error.message };

  for (const c of candidates ?? []) {
    const m = (c as { metadata?: Record<string, unknown> }).metadata ?? {};
    const store = String(m.import_store_id ?? m.ledger_store_id ?? m.store_id ?? "").trim();
    if (store !== sid) continue;
    const rowSha = String(m.content_sha256 ?? "").trim().toLowerCase();
    if (rowSha !== shaIn) continue;
    if (m.pim_import_cancelled === true) continue;
    const job = (m.pim_import_job as unknown as Record<string, unknown> | undefined) ?? {};
    const life = String(job.lifecycle ?? "").trim().toLowerCase();
    if (life === "completed" || life === "cancelled") continue;
    const pstat = String(m.preview_status ?? "").trim().toLowerCase();
    const active =
      life === "previewing" ||
      life === "waiting_for_confirmation" ||
      life === "import_queued" ||
      life === "importing" ||
      life === "failed" ||
      life === "uploaded" ||
      pstat === "previewing" ||
      pstat === "preview_ready" ||
      pstat === "import_partial_failed" ||
      pstat === "failed";
    if (!active) continue;
    const cid = String((c as { id?: string }).id ?? "").trim();
    if (!isUuidString(cid)) continue;

    return {
      ok: true,
      found: true,
      uploadId: cid,
      importSessionId: null,
      fileName: typeof (c as { file_name?: string }).file_name === "string" ? String((c as { file_name: string }).file_name) : null,
      lifecycle: life || null,
      previewStatus: pstat || null,
    };
  }

  return { ok: true, found: false, uploadId: null, importSessionId: null, fileName: null, lifecycle: null, previewStatus: null };
}

/** History list row id equals `raw_report_uploads.id` (session table not used). */
export type PimSuggestedActiveImport = { upload_id: string; file_name: string };

/** Admin-only diagnostics for Product Master history query (when `includeHistoryDebug` + permission). */
export type PimImportHistoryQueryDebug = {
  organization_id: string;
  report_type_filter: string;
  pim_product_master_row_count: number;
  legacy_catalog_seed_row_count: number;
  merged_unique_row_count: number;
  limited_to: number;
  returned_rows: { id: string; file_name: string; report_type: string | null }[];
  include_upload_ids_requested: string[];
  forced_fetch_missing_reasons: Record<string, string>;
};

/**
 * PIM seed import history: `raw_report_uploads` for org (newest first).
 * Primary filter: `report_type = pim_product_master`. Legacy `pim_catalog_seed` / `PIM_CATALOG_SEED` merged in.
 * Does not filter by store, terminal status, or file_processing_status.
 * If `includeUploadIds` are provided, those rows are fetched by id and merged in (even if outside the window).
 */
export async function listPimImportSessions(input: {
  organizationId: string;
  /** When set, used only to tag `store_mismatch` on rows — history is org-wide. */
  storeId?: string;
  limit?: number;
  /** Upload ids that must appear in the result regardless of store match (e.g. current active import). */
  includeUploadIds?: string[];
  /** When true, returns `historyQueryDebug` if the user may view PIM enrichment debug. */
  includeHistoryDebug?: boolean;
}): Promise<
  | {
      ok: true;
      rows: PimImportSessionListRow[];
      unlinkedRows: PimUnlinkedUploadRow[];
      ensureStats: EnsurePimImportSessionsResult;
      suggestedActive: PimSuggestedActiveImport | null;
      historyQueryDebug?: PimImportHistoryQueryDebug;
    }
  | { ok: false; error: string }
> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  const sid = String(input.storeId ?? "").trim();
  if (sid && !isUuidString(sid)) return { ok: false, error: "Invalid store." };
  const lim = Math.min(200, Math.max(1, input.limit ?? 100));

  const oid = input.organizationId.trim();

  const { data: pmUploads, error: pmErr } = await supabaseServer
    .from("raw_report_uploads")
    .select("id,file_name,created_at,updated_at,status,row_count,metadata,error_message,report_type,created_by")
    .eq("organization_id", oid)
    .eq("report_type", PIM_PRODUCT_MASTER_REPORT_TYPE)
    .order("created_at", { ascending: false })
    .limit(800);

  if (pmErr) return { ok: false, error: pmErr.message };

  const { data: legacySeedUploads } = await supabaseServer
    .from("raw_report_uploads")
    .select("id,file_name,created_at,updated_at,status,row_count,metadata,error_message,report_type,created_by")
    .eq("organization_id", oid)
    .in("report_type", [...PIM_HISTORY_LEGACY_SEED_TYPES])
    .order("created_at", { ascending: false })
    .limit(200);

  const mergedById = new Map<string, RawReportUploadListRow>();
  for (const u of [...(pmUploads ?? []), ...(legacySeedUploads ?? [])]) {
    const uid = String((u as { id?: string }).id ?? "").trim();
    if (!uid || mergedById.has(uid)) continue;
    mergedById.set(uid, u as RawReportUploadListRow);
  }

  const relevant = Array.from(mergedById.values()).sort((a, b) => {
    const ta = new Date((a as { created_at?: string | null }).created_at ?? 0).getTime();
    const tb = new Date((b as { created_at?: string | null }).created_at ?? 0).getTime();
    return tb - ta;
  });

  const ensureStats = pimListStatsFromRawScan(relevant.length);

  const uploaderIds = [
    ...new Set(
      relevant
        .map((u) => String((u as { created_by?: string | null }).created_by ?? "").trim())
        .filter(isUuidString),
    ),
  ];
  const nameById = new Map<string, string>();
  if (uploaderIds.length) {
    const { data: profs } = await supabaseServer.from("profiles").select("id, full_name").in("id", uploaderIds);
    for (const p of profs ?? []) {
      const id = String((p as { id?: string }).id ?? "").trim();
      const nm = String((p as { full_name?: string | null }).full_name ?? "").trim();
      if (id) nameById.set(id, nm || id);
    }
  }

  const slice = relevant.slice(0, lim);
  const rows: PimImportSessionListRow[] = [];
  for (const u of slice) {
    const row = mapRawReportUploadToHistoryRow(
      u as {
        id?: string;
        file_name?: string | null;
        created_at?: string | null;
        updated_at?: string | null;
        status?: string | null;
        row_count?: number | null;
        metadata?: Record<string, unknown> | null;
        error_message?: string | null;
        report_type?: string | null;
        created_by?: string | null;
      },
      nameById,
    );
    if (row) {
      // Tag row as store_mismatch if its metadata store doesn't match the selected store
      const m = ((u as { metadata?: Record<string, unknown> }).metadata ?? {}) as unknown as Record<string, unknown>;
      const uploadStore = uploadStoreIdFromMetadata(m);
      if (sid && uploadStore && uploadStore !== sid) {
        (row as PimImportSessionListRow & { store_mismatch?: boolean }).store_mismatch = true;
      }
      rows.push(row);
    }
  }

  const unlinkedRows: PimUnlinkedUploadRow[] = [];

  // Force-include any explicitly requested upload IDs (e.g. current active import).
  const forcedFetchMissingReasons: Record<string, string> = {};
  const forcedIds = (input.includeUploadIds ?? []).filter(isUuidString);
  if (forcedIds.length > 0) {
    const presentIds = new Set(rows.map((r) => r.upload_id));
    const missingIds = forcedIds.filter((id) => !presentIds.has(id));
    if (missingIds.length > 0) {
      const { data: forcedUploads } = await supabaseServer
        .from("raw_report_uploads")
        .select("id,file_name,created_at,updated_at,status,row_count,metadata,error_message,report_type,created_by")
        .eq("organization_id", oid)
        .in("id", missingIds);
      const byForcedId = new Map<string, RawReportUploadListRow>();
      for (const u of forcedUploads ?? []) {
        const id = String((u as { id?: string }).id ?? "").trim();
        if (id) byForcedId.set(id, u as RawReportUploadListRow);
      }
      for (const id of missingIds) {
        const u = byForcedId.get(id);
        if (!u) {
          forcedFetchMissingReasons[id] = "no_raw_report_uploads_row_for_organization_and_id";
          continue;
        }
        const m = ((u as { metadata?: Record<string, unknown> }).metadata ?? {}) as unknown as Record<string, unknown>;
        const forcedRow = mapRawReportUploadToHistoryRow(
          u as {
            id?: string;
            file_name?: string | null;
            created_at?: string | null;
            updated_at?: string | null;
            status?: string | null;
            row_count?: number | null;
            metadata?: Record<string, unknown> | null;
            error_message?: string | null;
            report_type?: string | null;
            created_by?: string | null;
          },
          nameById,
        );
        if (!forcedRow) {
          forcedFetchMissingReasons[id] = "history_mapper_returned_null";
          continue;
        }
        const uploadStoreF = uploadStoreIdFromMetadata(m);
        if (sid && uploadStoreF && uploadStoreF !== sid) {
          (forcedRow as PimImportSessionListRow & { store_mismatch?: boolean }).store_mismatch = true;
        }
        rows.unshift(forcedRow);
      }
    }
  }

  let suggestedActive: PimSuggestedActiveImport | null = null;
  for (const r of rows) {
    if (isSuggestedActivePimImportRow(r)) {
      suggestedActive = { upload_id: r.upload_id.trim(), file_name: r.file_name };
      break;
    }
  }

  let historyQueryDebug: PimImportHistoryQueryDebug | undefined;
  if (input.includeHistoryDebug && (await userCanViewPimEnrichmentDebug(oid))) {
    historyQueryDebug = {
      organization_id: oid,
      report_type_filter: `${PIM_PRODUCT_MASTER_REPORT_TYPE} (+ legacy ${PIM_HISTORY_LEGACY_SEED_TYPES.join(", ")})`,
      pim_product_master_row_count: pmUploads?.length ?? 0,
      legacy_catalog_seed_row_count: legacySeedUploads?.length ?? 0,
      merged_unique_row_count: relevant.length,
      limited_to: lim,
      returned_rows: rows.map((r) => ({
        id: r.upload_id,
        file_name: r.file_name,
        report_type: r.report_type ?? null,
      })),
      include_upload_ids_requested: forcedIds,
      forced_fetch_missing_reasons: forcedFetchMissingReasons,
    };
  }

  return { ok: true, rows, unlinkedRows, ensureStats, suggestedActive, historyQueryDebug };
}

/**
 * Auto-resume: newest row in {@link listPimImportSessions} that matches active-import rules.
 */
async function pickSuggestedActivePimImport(input: {
  organizationId: string;
  storeId: string;
}): Promise<
  | { ok: true; row: PimResumableProductMasterRow | null; ensureStats: EnsurePimImportSessionsResult }
  | { ok: false; error: string }
> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  const sid = input.storeId.trim();
  if (!isUuidString(sid)) return { ok: false, error: "Invalid store." };

  const listRes = await listPimImportSessions({
    organizationId: input.organizationId,
    storeId: sid,
    limit: 80,
  });
  if (!listRes.ok) return { ok: false, error: listRes.error };

  const sug = listRes.suggestedActive;
  if (!sug) return { ok: true, row: null, ensureStats: listRes.ensureStats };

  const uid = sug.upload_id.trim();
  const { data: rawUp } = await supabaseServer
    .from("raw_report_uploads")
    .select("id,file_name,status,metadata")
    .eq("id", uid)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (!rawUp) return { ok: true, row: null, ensureStats: listRes.ensureStats };

  const m = ((rawUp as { metadata?: Record<string, unknown> }).metadata ?? {}) as unknown as Record<string, unknown>;
  return {
    ok: true,
    row: {
      id: uid,
      file_name: String((rawUp as { file_name?: string }).file_name ?? sug.file_name),
      status: String((rawUp as { status?: string }).status ?? ""),
      metadata: m,
    },
    ensureStats: listRes.ensureStats,
  };
}

/** `sessionId` is `raw_report_uploads.id` (same id shown in import history). */
export async function getPimImportSession(input: {
  organizationId: string;
  sessionId: string;
}): Promise<{ ok: true; row: PimImportSessionListRow } | { ok: false; error: string }> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  const uploadId = input.sessionId.trim();
  if (!isUuidString(uploadId)) return { ok: false, error: "Invalid upload id." };

  const { data: up, error } = await supabaseServer
    .from("raw_report_uploads")
    .select("id,file_name,created_at,updated_at,status,row_count,metadata,error_message,report_type,created_by")
    .eq("id", uploadId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (error || !up) return { ok: false, error: error?.message ?? "Upload not found." };

  const rt = String((up as { report_type?: string }).report_type ?? "");
  const upMeta = ((up as { metadata?: Record<string, unknown> }).metadata ?? {}) as unknown as Record<string, unknown>;
  if (!(PIM_SESSION_REPORT_TYPES as readonly string[]).includes(rt) && !isPimMetadataRow(upMeta)) {
    return { ok: false, error: "Not a PIM catalog seed / Product Master upload." };
  }

  const cb = String((up as { created_by?: string | null }).created_by ?? "").trim();
  const nameById = new Map<string, string>();
  if (cb && isUuidString(cb)) {
    const { data: profs } = await supabaseServer.from("profiles").select("id, full_name").eq("id", cb).maybeSingle();
    const nm = String((profs as { full_name?: string | null } | null)?.full_name ?? "").trim();
    if (cb) nameById.set(cb, nm || cb);
  }

  const row = mapRawReportUploadToHistoryRow(
    up as {
      id?: string;
      file_name?: string | null;
      created_at?: string | null;
      updated_at?: string | null;
      status?: string | null;
      row_count?: number | null;
      metadata?: Record<string, unknown> | null;
      error_message?: string | null;
      report_type?: string | null;
      created_by?: string | null;
    },
    nameById,
  );
  if (!row) return { ok: false, error: "Invalid upload row." };
  return { ok: true, row };
}

/**
 * Clears apply checkpoint and unconfirms import — does not delete catalog products or storage files.
 * User must run Confirm &amp; Import again after reset.
 */
export async function resetPimImportJobState(input: {
  organizationId: string;
  uploadId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  const uid = input.uploadId.trim();
  if (!isUuidString(uid)) return { ok: false, error: "Invalid upload id." };

  const { data: upRow, error: uErr } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata,report_type")
    .eq("id", uid)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (uErr || !upRow) return { ok: false, error: uErr?.message ?? "Upload not found." };
  const rt = String((upRow as { report_type?: string }).report_type ?? "");
  const resetMeta = ((upRow as { metadata?: Record<string, unknown> }).metadata ?? {}) as unknown as Record<string, unknown>;
  if (!(PIM_SESSION_REPORT_TYPES as readonly string[]).includes(rt) && !isPimMetadataRow(resetMeta)) {
    return { ok: false, error: "Not a Product Master / catalog seed import session." };
  }

  const prev = (upRow as { metadata?: unknown }).metadata;
  const m = (prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {}) as unknown as Record<string, unknown>;
  const j =
    typeof m.pim_import_job === "object" && m.pim_import_job !== null && !Array.isArray(m.pim_import_job)
      ? ({ ...(m.pim_import_job as unknown as Record<string, unknown>) } as unknown as Record<string, unknown>)
      : {};
  const pstat = String(m.preview_status ?? "").toLowerCase();
  const life = String(j.lifecycle ?? "").toLowerCase();
  const hasPreviewReady =
    pstat === "preview_ready" || life === "waiting_for_confirmation" || life === "preview_ready";
  const now = new Date().toISOString();
  const nextJob: Record<string, unknown> = {
    ...j,
    apply_cursor: null,
    apply_metrics: null,
    last_error: null,
    progress_pct: hasPreviewReady ? 100 : Number(j.progress_pct) || 0,
    stage_label: hasPreviewReady ? "preview_ready" : "reset",
    lifecycle: hasPreviewReady ? "waiting_for_confirmation" : "uploaded",
    reset_at: now,
    reset_note:
      "Job reset from dashboard — confirm import again before applying. Existing catalog products are unchanged.",
  };

  const meta2 = mergeUploadMetadata(prev, {
    pim_import_confirmed: false,
    import_job_status: hasPreviewReady ? "preview_ready" : "uploaded",
    ...(hasPreviewReady ? { preview_status: "preview_ready" } : { preview_status: "reset" }),
    pim_import_job: nextJob,
    pim_ui_reset_at: now,
  });

  const { error: upErr } = await supabaseServer
    .from("raw_report_uploads")
    .update({ metadata: meta2, updated_at: now })
    .eq("id", uid)
    .eq("organization_id", input.organizationId);
  if (upErr) return { ok: false, error: upErr.message };

  return { ok: true };
}

/**
 * Remove merged workbook + CSV scan cache objects for this session’s upload (preview artifacts only).
 */
export async function clearPimImportSessionStaging(input: {
  organizationId: string;
  sessionId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  /** Alias for `raw_report_uploads.id`. */
  const uploadId = input.sessionId.trim();
  if (!isUuidString(uploadId)) return { ok: false, error: "Invalid upload id." };

  const { data: upRow, error: uErr } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata")
    .eq("id", uploadId)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (uErr || !upRow) return { ok: false, error: uErr?.message ?? "Upload not found." };

  const prev = (upRow as { metadata?: unknown }).metadata;
  const m = (prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {}) as unknown as Record<string, unknown>;
  const paths: string[] = [];
  const merged = typeof m.pim_merged_storage_path === "string" ? m.pim_merged_storage_path.trim() : "";
  const scan = typeof m.pim_csv_scan_cache_storage === "string" ? m.pim_csv_scan_cache_storage.trim() : "";
  if (merged) paths.push(merged);
  if (scan) paths.push(scan);
  if (paths.length) {
    await supabaseServer.storage.from(RAW_BUCKET).remove(paths);
  }

  const meta2 = mergeUploadMetadata(prev, {
    pim_merged_storage_path: null,
    pim_csv_scan_cache_storage: null,
    preview_status: "uploaded",
    pim_import_job: {
      ...(typeof m.pim_import_job === "object" && m.pim_import_job !== null && !Array.isArray(m.pim_import_job)
        ? (m.pim_import_job as unknown as Record<string, unknown>)
        : {}),
      lifecycle: "uploaded",
      stage_label: "staging_cleared",
      progress_pct: 0,
      last_step_at: new Date().toISOString(),
    },
  });

  await supabaseServer
    .from("raw_report_uploads")
    .update({ metadata: meta2, updated_at: new Date().toISOString() })
    .eq("id", uploadId)
    .eq("organization_id", input.organizationId);

  return { ok: true };
}

function isPimSessionRowSafeToClearAsStale(row: PimImportSessionListRow): boolean {
  const am =
    row.apply_metrics && typeof row.apply_metrics === "object"
      ? (row.apply_metrics as unknown as Record<string, unknown>)
      : {};
  const pc = Number(am.products_created ?? 0);
  const pu = Number(am.products_updated ?? 0);
  const pi = Number(am.prices_inserted ?? 0);
  const ident = Number(am.identifiers_created ?? am.skus_mapped ?? 0);
  if (pc + pu + pi + ident > 0) return false;
  const p = String(row.preview_status ?? "").toLowerCase();
  const life = String(row.lifecycle ?? "").toLowerCase();
  if (life === "importing" || life === "previewing" || p === "previewing") return false;
  const ss = String(row.session_status ?? "").toLowerCase();
  if (ss === "importing" || ss === "preview_running") return false;
  const stale = new Set(["uploaded", "preview_ready", "failed", "cancelled", "reset", "preview_failed"]);
  return stale.has(p) || stale.has(ss);
}

/**
 * Admin/debug: delete stale Product Master uploads for this store (`raw_report_uploads` only; no catalog rollback).
 */
export async function clearStalePimUploadsForStore(input: {
  organizationId: string;
  storeId: string;
}): Promise<{ ok: true; deletedUploadIds: string[]; candidateCount: number } | { ok: false; error: string }> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  const allowed = await userCanViewPimEnrichmentDebug(input.organizationId);
  if (!allowed) return { ok: false, error: "You do not have permission to clear stale uploads." };

  const sid = input.storeId.trim();
  if (!isUuidString(sid)) return { ok: false, error: "Invalid store." };

  const listRes = await listPimImportSessions({ organizationId: input.organizationId, storeId: sid, limit: 80 });
  if (!listRes.ok) return { ok: false, error: listRes.error };

  const staleIds: string[] = [];
  for (const row of listRes.rows) {
    if (isPimSessionRowSafeToClearAsStale(row)) staleIds.push(row.upload_id.trim());
  }

  const allIds = [...new Set(staleIds)];

  if (!allIds.length) return { ok: true, deletedUploadIds: [], candidateCount: 0 };

  const del = await deletePimImportUploads({ organizationId: input.organizationId, uploadIds: allIds });
  if (!del.ok) return del;

  return { ok: true, deletedUploadIds: allIds, candidateCount: allIds.length };
}

/** Dev/support one-shot counts after ensure + list (safe to call from the browser in development). */
export async function getPimImportSyncDiagnostics(input: {
  organizationId: string;
  storeId: string;
}): Promise<
  | {
      ok: true;
      rawUploadsScannedForStore: number;
      sessionsForStore: number;
      unlinkedUploadRows: number;
      backfilledLastRun: number;
      suggestedActive: PimSuggestedActiveImport | null;
      ensureStats: EnsurePimImportSessionsResult;
    }
  | { ok: false; error: string }
> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  const sid = input.storeId.trim();
  if (!isUuidString(sid)) return { ok: false, error: "Invalid store." };

  const listRes = await listPimImportSessions({ organizationId: input.organizationId, storeId: sid, limit: 80 });
  if (!listRes.ok) return { ok: false, error: listRes.error };
  const es = listRes.ensureStats;

  return {
    ok: true,
    rawUploadsScannedForStore: es.scannedRawUploads,
    sessionsForStore: es.sessionsForStore,
    unlinkedUploadRows: listRes.unlinkedRows.length,
    backfilledLastRun: es.backfilled,
    suggestedActive: listRes.suggestedActive,
    ensureStats: es,
  };
}

/** Reset preview scan on the same upload row (cooperative with chunked preview-step polling). */
export async function retryPimImportPreviewSession(input: {
  organizationId: string;
  storeId: string;
  uploadId: string;
}): Promise<{ ok: true; payload: unknown } | { ok: false; error: string }> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  if (!isUuidString(input.storeId.trim()) || !isUuidString(input.uploadId)) {
    return { ok: false, error: "Invalid store or upload id." };
  }
  const r = await pimEtlRetryPreview({
    organization_id: input.organizationId,
    store_id: input.storeId.trim(),
    upload_id: input.uploadId.trim(),
  });
  const payload = r.json ?? { ok: false, error: "empty_etl_response" };
  if (!r.ok) {
    const msg =
      typeof (payload as { error?: string }).error === "string"
        ? (payload as { error: string }).error
        : "ETL retry-preview failed.";
    return { ok: false, error: msg };
  }
  return { ok: true, payload };
}

/**
 * Repair action: re-assign a PIM upload to the specified store by patching its metadata store fields.
 * After calling this, refreshHistory will include the upload in the correct store's history.
 */
export async function assignPimUploadToStore(input: {
  organizationId: string;
  uploadId: string;
  targetStoreId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  const uid = input.uploadId.trim();
  const sid = input.targetStoreId.trim();
  if (!isUuidString(uid)) return { ok: false, error: "Invalid upload id." };
  if (!isUuidString(sid)) return { ok: false, error: "Invalid store id." };

  const { data: upRow, error: uErr } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata,report_type")
    .eq("id", uid)
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (uErr || !upRow) return { ok: false, error: uErr?.message ?? "Upload not found." };

  const prev = (upRow as { metadata?: unknown }).metadata;
  const m = (prev && typeof prev === "object" && !Array.isArray(prev) ? prev : {}) as unknown as Record<string, unknown>;

  const { mergeUploadMetadata } = await import("../../../lib/raw-report-upload-metadata");
  const meta2 = mergeUploadMetadata(prev, {
    import_store_id: sid,
    ledger_store_id: sid,
    ...(({
      store_id: sid,
      target_store_id: sid,
      pim_store_id: sid,
      storeId: sid,
      _store_reassigned_at: new Date().toISOString(),
      _store_reassigned_from: uploadStoreIdFromMetadata(m) || null,
    }) as unknown as Record<string, unknown>),
  });

  const { error: upErr } = await supabaseServer
    .from("raw_report_uploads")
    .update({ metadata: meta2, updated_at: new Date().toISOString() })
    .eq("id", uid)
    .eq("organization_id", input.organizationId);

  if (upErr) return { ok: false, error: upErr.message };
  return { ok: true };
}

/**
 * Admin repair tool: soft-delete wrong identifier_map links that cause preview conflicts.
 * Writes to pim_conflict_audit_log for every detached row.
 * Use dryRun: true (default) to preview what would be detached without writing.
 * Pass confirmRecent: true to override the 24-hour recency safeguard.
 */
export async function detachConflictingImapRows(input: {
  organizationId: string;
  storeId: string;
  /** The product_id that SHOULD own these identifiers (from conflict_detail.resolved_pid). */
  keepProductId: string;
  sellerSku?: string | null;
  asin?: string | null;
  fnsku?: string | null;
  upc?: string | null;
  uploadId?: string | null;
  /** Default true — preview without writing. */
  dryRun?: boolean;
  /** Required if any target product was updated in the last 24h. */
  confirmRecent?: boolean;
}): Promise<{
  ok: true;
  would_detach: number;
  detached: number;
  imap_rows: { id: string; product_id: string; identifier_type: string; identifier_value: string }[];
} | { ok: false; error: string }> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };

  const allowed = await userCanViewPimEnrichmentDebug(input.organizationId);
  if (!allowed) return { ok: false, error: "Admin role required to repair identifier conflicts." };

  const sid = input.storeId.trim();
  const keepPid = input.keepProductId.trim();
  if (!isUuidString(sid) || !isUuidString(keepPid)) return { ok: false, error: "Invalid ids." };

  const dryRun = input.dryRun !== false; // default true

  // Build list of identifier checks
  const checks: { col: string; val: string }[] = [];
  if (input.sellerSku?.trim()) checks.push({ col: "seller_sku", val: input.sellerSku.trim() });
  if (input.asin?.trim()) checks.push({ col: "asin", val: input.asin.trim() });
  if (input.fnsku?.trim()) checks.push({ col: "fnsku", val: input.fnsku.trim() });
  if (input.upc?.trim()) checks.push({ col: "upc_code", val: input.upc.trim() });
  if (!checks.length) return { ok: false, error: "No identifiers provided." };

  // Find all imap rows for these identifiers that point to a DIFFERENT product
  const imap_rows_found: { id: string; product_id: string; identifier_type: string; identifier_value: string }[] = [];
  for (const { col, val } of checks) {
    const { data: rows } = await supabaseServer
      .from("product_identifier_map")
      .select("id,product_id")
      .eq("organization_id", input.organizationId)
      .eq("store_id", sid)
      .eq(col, val)
      .is("deleted_at", null)
      .neq("product_id", keepPid)
      .limit(20);
    for (const r of rows ?? []) {
      const id = String((r as { id?: string }).id ?? "").trim();
      const pid = String((r as { product_id?: string }).product_id ?? "").trim();
      if (id && pid) {
        imap_rows_found.push({ id, product_id: pid, identifier_type: col, identifier_value: val });
      }
    }
  }

  if (!imap_rows_found.length) return { ok: true, would_detach: 0, detached: 0, imap_rows: [] };

  // Recency safeguard: check if any target product was updated in the last 24h
  if (!input.confirmRecent) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const uniquePids = [...new Set(imap_rows_found.map((r) => r.product_id))];
    const { data: recentProducts } = await supabaseServer
      .from("products")
      .select("id,updated_at")
      .in("id", uniquePids)
      .gte("updated_at", cutoff)
      .limit(5);
    if (recentProducts && recentProducts.length > 0) {
      return {
        ok: false,
        error: `recently_updated_products: ${recentProducts.length} affected products were updated in the last 24h. Pass confirmRecent: true to proceed.`,
      };
    }
  }

  if (dryRun) {
    return { ok: true, would_detach: imap_rows_found.length, detached: 0, imap_rows: imap_rows_found };
  }

  // Actual detach: soft-delete wrong imap rows
  const idsToDetach = imap_rows_found.map((r) => r.id);
  const now = new Date().toISOString();
  const { error: detachErr } = await supabaseServer
    .from("product_identifier_map")
    .update({ deleted_at: now })
    .in("id", idsToDetach)
    .eq("organization_id", input.organizationId);
  if (detachErr) return { ok: false, error: detachErr.message };

  // Write audit log rows
  const auditRows = imap_rows_found.map((r) => ({
    organization_id: input.organizationId,
    store_id: sid,
    performed_by: gate.userId,
    action: "detach_imap",
    upload_id: input.uploadId ?? null,
    imap_row_id: r.id,
    identifier_type: r.identifier_type,
    identifier_value: r.identifier_value,
    before_product_id: r.product_id,
    after_product_id: keepPid,
    performed_at: now,
    notes: `Detached to resolve preview conflict. Keep product: ${keepPid}`,
  }));
  try {
    await supabaseServer.from("pim_conflict_audit_log").insert(auditRows);
  } catch {
    // Non-fatal — detach was successful, audit log write failed silently
  }

  return { ok: true, would_detach: imap_rows_found.length, detached: idsToDetach.length, imap_rows: imap_rows_found };
}

/** Latest `file_processing_status.import_metrics` for a Product Master upload (price backfill checkpoints live here). */
export async function getPimImportFileProcessingMetrics(input: {
  organizationId: string;
  uploadId: string;
}): Promise<{ ok: true; import_metrics: Record<string, unknown> | null } | { ok: false; error: string }> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  const uid = String(input.uploadId ?? "").trim();
  if (!isUuidString(uid)) return { ok: false, error: "Invalid upload id." };

  const { data, error } = await supabaseServer
    .from("file_processing_status")
    .select("import_metrics")
    .eq("upload_id", uid)
    .eq("organization_id", input.organizationId.trim())
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  const im = data?.import_metrics;
  return {
    ok: true,
    import_metrics: im && typeof im === "object" && !Array.isArray(im) ? (im as unknown as Record<string, unknown>) : null,
  };
}

/**
 * One bounded chunk of Product Master price backfill (ETL checkpoints in `file_processing_status.import_metrics`).
 * Admin-gated; callers should loop until `done` or `terminal`.
 */
export async function pimPriceBackfillStep(input: {
  organizationId: string;
  uploadId: string;
  rowChunk?: number | null;
  restart?: boolean;
  cancel?: boolean;
}): Promise<
  | {
      ok: true;
      done: boolean;
      terminal?: boolean;
      paused?: boolean;
      cancelled?: boolean;
      cached?: boolean;
      chunk_rows?: number;
      price_backfill: Record<string, unknown> | null;
      user_hint?: string | null;
    }
  | { ok: false; error: string; user_hint?: string | null; price_backfill?: Record<string, unknown> | null }
> {
  const gate = await assertUserCanAccessOrganization(input.organizationId);
  if (!gate.ok) return { ok: false, error: gate.error };
  if (!(await userCanRunPimPriceBackfill(input.organizationId))) {
    return { ok: false, error: "Only administrators can run price backfill." };
  }
  const uid = String(input.uploadId ?? "").trim();
  if (!isUuidString(uid)) return { ok: false, error: "Invalid upload id." };

  const r = await pimEtlPriceBackfillStep({
    organization_id: input.organizationId,
    upload_id: uid,
    row_chunk: input.rowChunk ?? undefined,
    restart: Boolean(input.restart),
    cancel: Boolean(input.cancel),
  });
  const status = r.timedOut ? 504 : r.status;
  const json = (r.json && typeof r.json === "object" ? r.json : {}) as unknown as Record<string, unknown>;
  if (!r.ok) {
    const det = json.detail;
    const msg =
      typeof json.message === "string"
        ? json.message
        : typeof json.user_hint === "string"
          ? json.user_hint
          : typeof det === "string"
            ? det
            : det && typeof det === "object" && typeof (det as { message?: string }).message === "string"
              ? String((det as { message: string }).message)
              : `ETL error (HTTP ${status}).`;
    return { ok: false, error: msg, user_hint: typeof json.user_hint === "string" ? json.user_hint : undefined };
  }
  if (json.ok === false) {
    return {
      ok: false,
      error: String(json.error ?? json.message ?? "backfill_step_failed"),
      user_hint: typeof json.user_hint === "string" ? json.user_hint : undefined,
      price_backfill:
        json.price_backfill && typeof json.price_backfill === "object"
          ? (json.price_backfill as unknown as Record<string, unknown>)
          : null,
    };
  }
  const bf =
    json.price_backfill && typeof json.price_backfill === "object" ? (json.price_backfill as unknown as Record<string, unknown>) : null;
  return {
    ok: true,
    done: Boolean(json.done),
    terminal: json.terminal !== undefined ? Boolean(json.terminal) : Boolean(json.done),
    paused: Boolean(json.paused),
    cancelled: Boolean(json.cancelled),
    cached: Boolean(json.cached),
    chunk_rows: typeof json.chunk_rows === "number" ? json.chunk_rows : undefined,
    price_backfill: bf,
    user_hint: typeof json.user_hint === "string" ? json.user_hint : null,
  };
}
