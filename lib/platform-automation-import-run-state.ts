import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { AMAZON_REPORTS_API_UPLOAD_SOURCE } from "./amazon/import-history-source-run";
import {
  parseSourceRun,
  sourceRunNeedsResume,
  type SourceRunState,
} from "./amazon/reports-api-source-run";
import { findActiveBackgroundJob } from "./jobs/repository";
import {
  EMPTY_MANUAL_RUN_STATE,
  type AutomationCardManualRunState,
  type StoreAutomationSettingsView,
} from "./platform-automation-settings-types";

function readMetadataStoreId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  for (const key of ["import_store_id", "ledger_store_id", "store_id"]) {
    const v = m[key];
    if (typeof v === "string" && v.trim()) return v.trim().toLowerCase();
  }
  return null;
}

function manualRunFromUploadRow(
  uploadId: string,
  metadata: unknown,
  uploadStatus: string | null,
): AutomationCardManualRunState {
  const sourceRun = parseSourceRun(metadata);
  const metaObj =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : null;
  const err =
    (sourceRun?.attempt?.last_error_detail ?? null) ||
    (typeof metaObj?.error_message === "string" ? metaObj.error_message : null);

  const state = sourceRun?.state ?? uploadStatus ?? null;
  const needsResume = sourceRun
    ? sourceRunNeedsResume(sourceRun.state as SourceRunState)
    : ["processing", "uploading", "pending"].includes(String(uploadStatus ?? "").toLowerCase());

  return {
    upload_id: uploadId,
    source_run_id: sourceRun?.source_run_id ?? null,
    needs_resume: needsResume,
    state,
    last_error: err,
    active_job_id: null,
    job_status: null,
  };
}

async function readLatestUploadManualRun(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  reportType: string,
): Promise<AutomationCardManualRunState> {
  const storeNorm = storeId.trim().toLowerCase();
  const { data, error } = await client
    .from("raw_report_uploads")
    .select("id, status, metadata, report_type")
    .eq("organization_id", organizationId)
    .eq("report_type", reportType)
    .order("created_at", { ascending: false })
    .limit(40);

  if (error || !data?.length) return { ...EMPTY_MANUAL_RUN_STATE };

  for (const raw of data) {
    const row = raw as Record<string, unknown>;
    const metaStore = readMetadataStoreId(row.metadata);
    if (metaStore && metaStore !== storeNorm) continue;
    const metaObj =
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null;
    const source = typeof metaObj?.source === "string" ? metaObj.source : "";
    if (source && source !== AMAZON_REPORTS_API_UPLOAD_SOURCE) continue;
    return manualRunFromUploadRow(String(row.id), row.metadata, String(row.status ?? ""));
  }

  return { ...EMPTY_MANUAL_RUN_STATE };
}

async function readLatestFinancesManualRun(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<AutomationCardManualRunState> {
  const { data, error } = await client
    .from("amazon_finances_source_runs")
    .select("id, state, store_id, metadata, attempt")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return { ...EMPTY_MANUAL_RUN_STATE };

  const row = data as Record<string, unknown>;
  const state = typeof row.state === "string" ? row.state : null;
  const attempt =
    row.attempt && typeof row.attempt === "object" && !Array.isArray(row.attempt)
      ? (row.attempt as Record<string, unknown>)
      : null;
  const needsResume = state === "requested" || state === "polling";
  const meta =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;
  const uploadId = typeof meta?.upload_id === "string" ? meta.upload_id : null;

  return {
    upload_id: uploadId,
    source_run_id: typeof row.id === "string" ? row.id : null,
    needs_resume: needsResume,
    state,
    last_error:
      typeof attempt?.last_error_detail === "string"
        ? attempt.last_error_detail
        : typeof attempt?.last_error_code === "string"
          ? attempt.last_error_code
          : null,
    active_job_id: null,
    job_status: null,
  };
}

async function readProductEnrichmentManualRun(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<AutomationCardManualRunState> {
  const active = await findActiveBackgroundJob(client, {
    organizationId,
    storeId,
    jobType: "product_enrichment",
  }).catch(() => null);

  if (active) {
    return {
      upload_id: null,
      source_run_id: null,
      needs_resume: active.status === "running" || active.status === "queued",
      state: active.status,
      last_error: active.last_error_detail ?? active.last_error_code ?? null,
      active_job_id: active.id,
      job_status: active.status,
    };
  }

  const { data, error } = await client
    .from("background_jobs")
    .select("id, status, finished_at, started_at, created_at, last_error_detail, last_error_code")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("job_type", "product_enrichment")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return { ...EMPTY_MANUAL_RUN_STATE };

  const row = data as Record<string, unknown>;
  const status = typeof row.status === "string" ? row.status : null;
  return {
    upload_id: null,
    source_run_id: null,
    needs_resume: false,
    state: status,
    last_error:
      typeof row.last_error_detail === "string"
        ? row.last_error_detail
        : typeof row.last_error_code === "string"
          ? row.last_error_code
          : null,
    active_job_id: typeof row.id === "string" ? row.id : null,
    job_status: status,
  };
}

export async function buildAutomationManualRunStates(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<StoreAutomationSettingsView["manual_runs"]> {
  const [product, reimbursements, settlement, finances, removalOrder, removalShipment] =
    await Promise.all([
      readProductEnrichmentManualRun(client, organizationId, storeId),
      readLatestUploadManualRun(client, organizationId, storeId, "REIMBURSEMENTS"),
      readLatestUploadManualRun(client, organizationId, storeId, "SETTLEMENT"),
      readLatestFinancesManualRun(client, organizationId, storeId),
      readLatestUploadManualRun(client, organizationId, storeId, "REMOVAL_ORDER"),
      readLatestUploadManualRun(client, organizationId, storeId, "REMOVAL_SHIPMENT"),
    ]);

  return {
    product_enrichment: product,
    reimbursements_api: reimbursements,
    settlement_api: settlement,
    finances_archive_api: finances,
    removal_order: removalOrder,
    removal_shipment: removalShipment,
  };
}
