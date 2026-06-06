import type { SupabaseClient } from "@supabase/supabase-js";

import { AMAZON_REPORTS_API_UPLOAD_SOURCE } from "./amazon/import-history-source-run";
import { readPlatformAutomationApiFlags } from "./platform-automation-api-flags";
import {
  computeApiCardNextRun,
  computeProductEnrichmentNextRun,
  computeRemovalHistoricalNextRun,
  computeRemovalRecentNextRun,
  normalizeStoreAutomationSettings,
} from "./platform-automation-schedule";
import { readStoreAutomationSettings } from "./platform-automation-scope-storage";
import { buildAutomationManualRunStates } from "./platform-automation-import-run-state";
import {
  DEFAULT_STORE_AUTOMATION_SETTINGS,
  EMPTY_AUTOMATION_RUNTIME,
  EMPTY_MANUAL_RUN_STATE,
  type AutomationRunStatus,
  type AutomationScheduleRuntime,
  type StoreAutomationSettingsView,
} from "./platform-automation-settings-types";

const REMOVAL_UPLOAD_TYPES = new Set(["REMOVAL_ORDER", "REMOVAL_SHIPMENT"]);

function mapJobStatus(status: string | null | undefined): AutomationRunStatus {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "cancelled":
      return "failed";
    case "running":
    case "queued":
    case "leased":
      return "running";
    default:
      return "never";
  }
}

function mapUploadStatus(status: string | null | undefined): AutomationRunStatus {
  const s = (status ?? "").toLowerCase();
  if (s === "synced" || s === "complete" || s === "completed") return "success";
  if (s === "failed") return "failed";
  if (s === "processing" || s === "uploading" || s === "pending") return "running";
  return "never";
}

function mapFinancesRunStatus(state: string | null | undefined): AutomationRunStatus {
  switch (state) {
    case "complete":
      return "success";
    case "failed":
      return "failed";
    case "requested":
    case "polling":
    case "archived":
      return "running";
    default:
      return "never";
  }
}

export async function readFinancesArchiveRuntime(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<{ last_run_at: string | null; last_run_status: AutomationRunStatus; last_error: string | null }> {
  const { data, error } = await client
    .from("amazon_finances_source_runs")
    .select("state, updated_at, created_at, attempt")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return { last_run_at: null, last_run_status: "never", last_error: null };
  }

  const row = data as Record<string, unknown>;
  const ts =
    (typeof row.updated_at === "string" && row.updated_at) ||
    (typeof row.created_at === "string" ? row.created_at : null);
  const attempt =
    row.attempt && typeof row.attempt === "object" && !Array.isArray(row.attempt)
      ? (row.attempt as Record<string, unknown>)
      : null;
  const err =
    typeof attempt?.last_error_detail === "string"
      ? attempt.last_error_detail
      : typeof attempt?.last_error_code === "string"
        ? attempt.last_error_code
        : null;

  return {
    last_run_at: ts,
    last_run_status: mapFinancesRunStatus(typeof row.state === "string" ? row.state : null),
    last_error: err,
  };
}

function readMetadataStoreId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  const candidates = [m.import_store_id, m.ledger_store_id, m.store_id];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().toLowerCase();
  }
  return null;
}

function withNextRun(
  base: Omit<AutomationScheduleRuntime, "next_run_at">,
  next: Date | null,
): AutomationScheduleRuntime {
  return {
    ...base,
    next_run_at: next ? next.toISOString() : null,
  };
}

async function readLatestEnrichmentJob(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<{ last_run_at: string | null; last_run_status: AutomationRunStatus; last_error: string | null }> {
  const { data, error } = await client
    .from("background_jobs")
    .select("status, finished_at, started_at, created_at, last_error, store_id")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("job_type", "product_enrichment")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return { last_run_at: null, last_run_status: "never", last_error: null };
  }

  const row = data as Record<string, unknown>;
  const ts =
    (typeof row.finished_at === "string" && row.finished_at) ||
    (typeof row.started_at === "string" && row.started_at) ||
    (typeof row.created_at === "string" ? row.created_at : null);

  return {
    last_run_at: ts,
    last_run_status: mapJobStatus(typeof row.status === "string" ? row.status : null),
    last_error: typeof row.last_error === "string" ? row.last_error : null,
  };
}

async function readLatestReportsApiUpload(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  reportTypes: string[],
): Promise<{ last_run_at: string | null; last_run_status: AutomationRunStatus; last_error: string | null }> {
  const storeNorm = storeId.trim().toLowerCase();
  const { data, error } = await client
    .from("raw_report_uploads")
    .select("status, created_at, updated_at, metadata, report_type")
    .eq("organization_id", organizationId)
    .in("report_type", reportTypes)
    .order("created_at", { ascending: false })
    .limit(40);

  if (error || !data?.length) {
    return { last_run_at: null, last_run_status: "never", last_error: null };
  }

  for (const raw of data) {
    const row = raw as Record<string, unknown>;
    const meta = row.metadata;
    const metaStore = readMetadataStoreId(meta);
    if (metaStore && metaStore !== storeNorm) continue;

    const metaObj = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null;
    const source = typeof metaObj?.source === "string" ? metaObj.source : "";
    if (source && source !== AMAZON_REPORTS_API_UPLOAD_SOURCE) continue;

    const ts =
      (typeof row.updated_at === "string" && row.updated_at) ||
      (typeof row.created_at === "string" ? row.created_at : null);
    const err =
      metaObj && typeof metaObj.error_message === "string"
        ? metaObj.error_message
        : null;

    return {
      last_run_at: ts,
      last_run_status: mapUploadStatus(typeof row.status === "string" ? row.status : null),
      last_error: err,
    };
  }

  return { last_run_at: null, last_run_status: "never", last_error: null };
}

/** @deprecated Prefer buildStoreAutomationSettingsView */
export async function buildPlatformAutomationSettingsView(
  client: SupabaseClient,
  rawSettings: unknown,
  updatedAt: string | null,
  organizationId: string,
  now: Date = new Date(),
  storeId?: string,
): Promise<StoreAutomationSettingsView> {
  const store = storeId?.trim() || "509ee1f6-622c-46a5-8110-7b889ba46c2c";
  return buildStoreAutomationSettingsView(client, rawSettings, organizationId, store, updatedAt, now);
}

export async function buildStoreAutomationSettingsView(
  client: SupabaseClient,
  rawSettings: unknown,
  organizationId: string,
  storeId: string,
  updatedAt: string | null,
  now: Date = new Date(),
): Promise<StoreAutomationSettingsView> {
  const settings = readStoreAutomationSettings(rawSettings, organizationId, storeId);

  let enrichmentJob = { last_run_at: null as string | null, last_run_status: "never" as AutomationRunStatus, last_error: null as string | null };
  let reimbursements = enrichmentJob;
  let settlement = enrichmentJob;
  let removal = enrichmentJob;
  let manualRuns = emptyStoreAutomationView(organizationId, storeId).manual_runs;
  let financesRuntime = enrichmentJob;

  try {
    [enrichmentJob, reimbursements, settlement, removal, manualRuns] = await Promise.all([
      readLatestEnrichmentJob(client, organizationId, storeId),
      readLatestReportsApiUpload(client, organizationId, storeId, ["REIMBURSEMENTS"]),
      readLatestReportsApiUpload(client, organizationId, storeId, ["SETTLEMENT"]),
      readLatestReportsApiUpload(client, organizationId, storeId, [...REMOVAL_UPLOAD_TYPES]),
      buildAutomationManualRunStates(client, organizationId, storeId),
    ]);
    financesRuntime = await readFinancesArchiveRuntime(client, organizationId, storeId);
  } catch (err) {
    console.error("[buildStoreAutomationSettingsView] runtime/manual_runs degraded:", err);
  }

  const cronRt = settings.removal_api_sync.cron_runtime;
  const removalRecentBase =
    cronRt?.last_run_at != null
      ? {
          last_run_at: cronRt.last_run_at,
          last_run_status: cronRt.last_run_status,
          last_error: cronRt.last_error,
        }
      : removal;
  const removalNext =
    cronRt?.next_run_at != null
      ? new Date(cronRt.next_run_at)
      : computeRemovalRecentNextRun(settings.removal_api_sync, now);

  return {
    ...settings,
    organization_id: organizationId,
    store_id: storeId,
    updated_at: updatedAt,
    manual_runs: manualRuns,
    api_flags: readPlatformAutomationApiFlags(),
    runtime: {
      product_enrichment: withNextRun(
        enrichmentJob,
        computeProductEnrichmentNextRun(settings.product_enrichment, now),
      ),
      removal_api_sync: {
        recent: withNextRun(removalRecentBase, removalNext),
        historical_backfill: withNextRun(
          { last_run_at: null, last_run_status: "never", last_error: null },
          computeRemovalHistoricalNextRun(settings.removal_api_sync, now),
        ),
      },
      reimbursements_api: withNextRun(
        reimbursements,
        computeApiCardNextRun(settings.reimbursements_api, now),
      ),
      settlement_api: withNextRun(
        settlement,
        computeApiCardNextRun(settings.settlement_api, now),
      ),
      finances_archive_api: withNextRun(
        financesRuntime,
        computeApiCardNextRun(settings.finances_archive_api, now),
      ),
    },
  };
}

export function emptyStoreAutomationView(
  organizationId: string,
  storeId: string,
): StoreAutomationSettingsView {
  const settings = DEFAULT_STORE_AUTOMATION_SETTINGS;
  const emptyRun = { ...EMPTY_MANUAL_RUN_STATE };
  return {
    ...settings,
    organization_id: organizationId,
    store_id: storeId,
    updated_at: null,
    manual_runs: {
      product_enrichment: { ...emptyRun },
      reimbursements_api: { ...emptyRun },
      settlement_api: { ...emptyRun },
      finances_archive_api: { ...emptyRun },
      removal_order: { ...emptyRun },
      removal_shipment: { ...emptyRun },
    },
    api_flags: readPlatformAutomationApiFlags(),
    runtime: {
      product_enrichment: { ...EMPTY_AUTOMATION_RUNTIME },
      removal_api_sync: {
        recent: { ...EMPTY_AUTOMATION_RUNTIME },
        historical_backfill: { ...EMPTY_AUTOMATION_RUNTIME },
      },
      reimbursements_api: { ...EMPTY_AUTOMATION_RUNTIME },
      settlement_api: { ...EMPTY_AUTOMATION_RUNTIME },
      finances_archive_api: { ...EMPTY_AUTOMATION_RUNTIME },
    },
  };
}

export function emptyAutomationView(): StoreAutomationSettingsView {
  return emptyStoreAutomationView(
    "00000000-0000-0000-0000-000000000001",
    "509ee1f6-622c-46a5-8110-7b889ba46c2c",
  );
}
