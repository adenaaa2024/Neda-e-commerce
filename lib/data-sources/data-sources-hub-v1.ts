/**
 * PHASE-DATA-SOURCES-HUB-AND-CLAIM-CENTER-NAV-UNIFICATION-V1
 *
 * SERVER-ONLY read-only composer — the SINGLE source-of-truth for API / import /
 * sync status across the whole system. Every status surface (Platform Settings,
 * Claim Center / Sources, Claim Data Coverage, Ready-to-File source blockers,
 * Reimbursement Tracking source status, Product Story sources) must read from
 * this composer so there is exactly one definition of "source status".
 *
 * It probes each domain table for row count + latest event date, joins the
 * Amazon worker flags + env keys + SP-API credential presence, and derives the
 * normalized status badge from {@link deriveDataSourceBadge}.
 *
 * NO DB writes. NO Amazon calls. NO AI. Read-only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { amazonSpCredentialsLookComplete } from "@/lib/amazon-marketplace-credentials";
import { isAmazonFinancesApiWorkerEnabled } from "@/lib/amazon/finances-api-worker-flags";
import { allReportsApiWorkerFlags } from "@/lib/amazon/reports-api-worker-flags";
import {
  SP_API_REPORT_TYPE_FBA_RETURNS,
  SP_API_REPORT_TYPE_FEE_PREVIEW,
  SP_API_REPORT_TYPE_INBOUND_PERFORMANCE,
  SP_API_REPORT_TYPE_INVENTORY_LEDGER,
  SP_API_REPORT_TYPE_REIMBURSEMENTS,
  SP_API_REPORT_TYPE_REMOVAL_ORDER,
  SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
} from "@/lib/amazon/reports-api-source-run";
import { SP_API_REPORT_TYPE_SETTLEMENT_V2 } from "@/lib/amazon/reports-api-settlement-plan";
import {
  DATA_SOURCES_HUB_V1,
  deriveDataSourceBadge,
  filterDataSourcesForView,
  type DataSourceCredentialStatus,
  type DataSourceDomain,
  type DataSourceFreshness,
  type DataSourceHubRow,
  type DataSourcesHubPayload,
  type DataSourcesHubTotals,
  type DataSourcesHubView,
} from "@/lib/data-sources/data-sources-hub-contract";

const DAY_MS = 24 * 60 * 60 * 1000;

type WorkerFlags = ReturnType<typeof allReportsApiWorkerFlags>;

type SourceSpec = {
  source_key: string;
  display_name: string;
  source_domain: DataSourceDomain;
  report_type_or_api_endpoint: string;
  sp_api_report_type: string | null;
  local_table: string | null;
  date_cols: string[];
  worker_flag: string | null;
  flag_enabled: (f: WorkerFlags, financesEnabled: boolean) => boolean;
  worker_built: boolean;
  /** true => Amazon SP-API connector source governed by worker flags + credentials. */
  is_control_plane_source: boolean;
  credential_required: boolean;
  schedule: string;
  stale_after_days: number;
  claim_family_coverage: string[];
  product_story_coverage: boolean;
};

function buildSourceSpecs(): SourceSpec[] {
  return [
    {
      source_key: "settlement",
      display_name: "Settlement Flat File V2",
      source_domain: "financial",
      report_type_or_api_endpoint: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
      sp_api_report_type: SP_API_REPORT_TYPE_SETTLEMENT_V2,
      local_table: "amazon_settlements",
      date_cols: ["posted_date", "settlement_start_date", "created_at"],
      worker_flag: "ENABLE_AMAZON_REPORTS_API_SETTLEMENT",
      flag_enabled: (f) => f.settlement_enabled,
      worker_built: true,
      is_control_plane_source: true,
      credential_required: true,
      schedule: "per settlement period (14d)",
      stale_after_days: 14,
      claim_family_coverage: ["settlement_refund_anomaly", "refund_without_return", "fba_fee_overcharge"],
      product_story_coverage: true,
    },
    {
      source_key: "reimbursements",
      display_name: "FBA Reimbursements",
      source_domain: "financial",
      report_type_or_api_endpoint: "GET_FBA_REIMBURSEMENTS_DATA",
      sp_api_report_type: SP_API_REPORT_TYPE_REIMBURSEMENTS,
      local_table: "amazon_reimbursements",
      date_cols: ["approval_date", "reimbursement_date", "created_at"],
      worker_flag: "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS",
      flag_enabled: (f) => f.reimbursements_enabled,
      worker_built: true,
      is_control_plane_source: true,
      credential_required: true,
      schedule: "daily",
      stale_after_days: 14,
      claim_family_coverage: [
        "missing_reimbursement",
        "partial_incorrect_reimbursement",
        "customer_return_not_reimbursed",
        "warehouse_lost_inventory",
        "warehouse_damaged_inventory",
      ],
      product_story_coverage: false,
    },
    {
      source_key: "removal_order",
      display_name: "Removal Order Detail",
      source_domain: "removal",
      report_type_or_api_endpoint: "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA",
      sp_api_report_type: SP_API_REPORT_TYPE_REMOVAL_ORDER,
      local_table: "amazon_removals",
      date_cols: ["order_date", "request_date", "created_at"],
      worker_flag: "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
      flag_enabled: (f) => f.removal_order_enabled,
      worker_built: true,
      is_control_plane_source: true,
      credential_required: true,
      schedule: "daily",
      stale_after_days: 3,
      claim_family_coverage: ["removal_order_discrepancy", "removal_fee_refund_mismatch"],
      product_story_coverage: true,
    },
    {
      source_key: "removal_shipment",
      display_name: "Removal Shipment Detail",
      source_domain: "removal",
      report_type_or_api_endpoint: "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA",
      sp_api_report_type: SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
      local_table: "amazon_removal_shipments",
      date_cols: ["shipment_date", "request_date", "created_at"],
      worker_flag: "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
      flag_enabled: (f) => f.removal_shipment_enabled,
      worker_built: true,
      is_control_plane_source: true,
      credential_required: true,
      schedule: "daily",
      stale_after_days: 3,
      claim_family_coverage: ["removal_shipment_missing", "removal_damaged_during_removal"],
      product_story_coverage: true,
    },
    {
      source_key: "fba_returns",
      display_name: "FBA Customer Returns",
      source_domain: "return",
      report_type_or_api_endpoint: "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA",
      sp_api_report_type: SP_API_REPORT_TYPE_FBA_RETURNS,
      local_table: "amazon_returns",
      date_cols: ["return_date", "created_at"],
      worker_flag: "ENABLE_AMAZON_REPORTS_API_FBA_RETURNS",
      flag_enabled: (f) => f.fba_returns_enabled,
      worker_built: true,
      is_control_plane_source: true,
      credential_required: true,
      schedule: "daily",
      stale_after_days: 7,
      claim_family_coverage: [
        "customer_return_not_reimbursed",
        "refund_without_return",
        "wrong_item_returned",
        "empty_box_return",
      ],
      product_story_coverage: true,
    },
    {
      source_key: "inventory_ledger",
      display_name: "Inventory Ledger (Detail View)",
      source_domain: "inventory",
      report_type_or_api_endpoint: "GET_LEDGER_DETAIL_VIEW_DATA",
      sp_api_report_type: SP_API_REPORT_TYPE_INVENTORY_LEDGER,
      local_table: "amazon_inventory_ledger",
      date_cols: ["event_date", "date", "created_at"],
      worker_flag: "ENABLE_AMAZON_REPORTS_API_INVENTORY_LEDGER",
      flag_enabled: (f) => f.inventory_ledger_enabled,
      worker_built: true,
      is_control_plane_source: true,
      credential_required: true,
      schedule: "daily",
      stale_after_days: 7,
      claim_family_coverage: [
        "warehouse_lost_inventory",
        "warehouse_damaged_inventory",
        "inventory_adjustment_error",
        "disposed_without_reimbursement",
      ],
      product_story_coverage: false,
    },
    {
      source_key: "fee_preview",
      display_name: "FBA Fee Preview",
      source_domain: "fee",
      report_type_or_api_endpoint: "GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA",
      sp_api_report_type: SP_API_REPORT_TYPE_FEE_PREVIEW,
      local_table: "amazon_fee_preview",
      date_cols: ["created_at"],
      worker_flag: "ENABLE_AMAZON_REPORTS_API_FEE_PREVIEW",
      flag_enabled: (f) => f.fee_preview_enabled,
      worker_built: true,
      is_control_plane_source: true,
      credential_required: true,
      schedule: "weekly",
      stale_after_days: 30,
      claim_family_coverage: ["fba_fee_overcharge", "dimension_weight_fee_issue"],
      product_story_coverage: false,
    },
    {
      source_key: "inbound_performance",
      display_name: "Inbound Shipment Performance",
      source_domain: "inbound",
      report_type_or_api_endpoint: "GET_FBA_FULFILLMENT_INBOUND_PERFORMANCE_DATA",
      sp_api_report_type: SP_API_REPORT_TYPE_INBOUND_PERFORMANCE,
      local_table: "amazon_inbound_performance",
      date_cols: ["created_at"],
      worker_flag: "ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE",
      flag_enabled: (f) => f.inbound_performance_enabled,
      worker_built: true,
      is_control_plane_source: true,
      credential_required: true,
      schedule: "daily",
      stale_after_days: 7,
      claim_family_coverage: ["inbound_shipment_shortage"],
      product_story_coverage: false,
    },
    {
      source_key: "finances_api",
      display_name: "Finances API (financial events)",
      source_domain: "financial",
      report_type_or_api_endpoint: "listFinancialEventGroups / listFinancialEventsByGroup",
      sp_api_report_type: null,
      local_table: "amazon_finances_events",
      date_cols: ["posted_date", "created_at"],
      worker_flag: "ENABLE_AMAZON_FINANCES_API_WORKER",
      flag_enabled: (_f, financesEnabled) => financesEnabled,
      worker_built: true,
      is_control_plane_source: true,
      credential_required: true,
      schedule: "daily",
      stale_after_days: 7,
      claim_family_coverage: ["settlement_refund_anomaly", "reimbursement_reversal"],
      product_story_coverage: false,
    },
    // ---- Non-Amazon-connector sources (no worker flag; local / catalog) ----
    {
      source_key: "product_identity",
      display_name: "Product Identity Map (catalog spine)",
      source_domain: "product",
      report_type_or_api_endpoint: "products + product_identifier_map (catalog spine)",
      sp_api_report_type: null,
      local_table: "product_identifier_map",
      date_cols: ["updated_at", "created_at"],
      worker_flag: null,
      flag_enabled: () => false,
      worker_built: false,
      is_control_plane_source: false,
      credential_required: false,
      schedule: "on catalog change / enrichment job",
      stale_after_days: 90,
      claim_family_coverage: ["ALL"],
      product_story_coverage: true,
    },
    {
      source_key: "scanner_returns",
      display_name: "Physical scanned return units",
      source_domain: "scanner",
      report_type_or_api_endpoint: "return_items (physical scanner — LOCKED)",
      sp_api_report_type: null,
      local_table: "return_items",
      date_cols: ["scanned_at", "created_at"],
      worker_flag: null,
      flag_enabled: () => false,
      worker_built: false,
      is_control_plane_source: false,
      credential_required: false,
      schedule: "real-time (scanner)",
      stale_after_days: 30,
      claim_family_coverage: ["physical_return_scanner_issue", "wrong_item_returned", "empty_box_return"],
      product_story_coverage: true,
    },
  ];
}

function freshnessFromDate(dateStr: string | null, staleAfterDays: number): "fresh" | "stale" | "unknown" {
  if (!dateStr) return "unknown";
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return "unknown";
  const age = (Date.now() - t) / DAY_MS;
  return age <= staleAfterDays ? "fresh" : "stale";
}

async function probeTable(
  client: SupabaseClient,
  orgId: string,
  table: string,
  dateCols: string[],
): Promise<{ count: number | null; last_event_date: string | null }> {
  const scoped = await client.from(table).select("*", { count: "exact", head: true }).eq("organization_id", orgId);
  let count: number | null;
  if (!scoped.error) {
    count = scoped.count ?? 0;
  } else {
    const code = (scoped.error as { code?: string }).code ?? "";
    if (code === "42P01") return { count: null, last_event_date: null }; // table missing
    // Table may lack organization_id — fall back to unscoped count.
    const unscoped = await client.from(table).select("*", { count: "exact", head: true });
    if (unscoped.error) return { count: null, last_event_date: null };
    count = unscoped.count ?? 0;
  }

  for (const col of dateCols) {
    const scopedDate = await client
      .from(table)
      .select(col)
      .eq("organization_id", orgId)
      .not(col, "is", null)
      .order(col, { ascending: false })
      .limit(1);
    const dq = scopedDate.error
      ? await client.from(table).select(col).not(col, "is", null).order(col, { ascending: false }).limit(1)
      : scopedDate;
    if (!dq.error && dq.data?.[0]) {
      const v = (dq.data[0] as unknown as Record<string, unknown>)[col];
      if (typeof v === "string") return { count, last_event_date: v };
    }
  }
  return { count, last_event_date: null };
}

const SUCCESS_STATES = new Set(["succeeded", "success", "completed", "complete", "done", "ok"]);

async function lastSourceRun(
  client: SupabaseClient,
  orgId: string,
  reportType: string,
): Promise<{ last_at: string | null; last_success_at: string | null; state: string | null; error: string | null }> {
  const q = await client
    .from("raw_report_uploads")
    .select("created_at, metadata")
    .eq("organization_id", orgId)
    .eq("report_type", reportType)
    .order("created_at", { ascending: false })
    .limit(1);
  if (q.error || !q.data?.[0]) return { last_at: null, last_success_at: null, state: null, error: null };
  const row = q.data[0] as { created_at: string; metadata?: unknown };
  const meta = (row.metadata ?? null) as Record<string, unknown> | null;
  const sr = (meta?.source_run ?? null) as Record<string, unknown> | null;
  const attempt = (sr?.attempt ?? null) as Record<string, unknown> | null;
  const state = typeof sr?.state === "string" ? sr.state : null;
  const isSuccess = state ? SUCCESS_STATES.has(state.toLowerCase()) : false;
  return {
    last_at: row.created_at,
    last_success_at: isSuccess ? row.created_at : null,
    state,
    error: typeof attempt?.last_error_code === "string" ? attempt.last_error_code : null,
  };
}

async function amazonCredentialStatus(
  client: SupabaseClient,
  orgId: string,
): Promise<DataSourceCredentialStatus> {
  const q = await client
    .from("marketplaces")
    .select("provider, credentials")
    .eq("organization_id", orgId)
    .limit(50);
  if (q.error) return "unknown";
  const rows = (q.data ?? []) as Array<{ provider?: string | null; credentials?: unknown }>;
  const amazonRows = rows.filter((r) => String(r.provider ?? "").toLowerCase().includes("amazon"));
  if (amazonRows.length === 0) return "missing";
  return amazonRows.some((r) => amazonSpCredentialsLookComplete(r.credentials)) ? "present" : "missing";
}

export type DataSourcesHubOptions = {
  view?: DataSourcesHubView;
  storeId?: string | null;
};

/**
 * Compose the unified Data Sources Hub status payload. The single composer all
 * status surfaces must read from. Read-only.
 */
export async function composeDataSourcesHubStatusV1(
  client: SupabaseClient,
  organizationId: string,
  options: DataSourcesHubOptions = {},
): Promise<DataSourcesHubPayload> {
  const view: DataSourcesHubView = options.view ?? "control_plane";
  const flags = allReportsApiWorkerFlags();
  const financesEnabled = isAmazonFinancesApiWorkerEnabled();
  const credentialStatus = await amazonCredentialStatus(client, organizationId);
  const cronSecretPresent = Boolean(process.env.CRON_SECRET?.trim());

  const specs = buildSourceSpecs();
  const sources: DataSourceHubRow[] = [];

  for (const spec of specs) {
    const probe = spec.local_table
      ? await probeTable(client, organizationId, spec.local_table, spec.date_cols)
      : { count: null, last_event_date: null };

    const run = spec.sp_api_report_type
      ? await lastSourceRun(client, organizationId, spec.sp_api_report_type)
      : { last_at: null, last_success_at: null, state: null, error: null };

    const enabled = spec.flag_enabled(flags, financesEnabled);
    const liveSpApiExists = spec.worker_built && enabled;
    const credential_status: DataSourceCredentialStatus = spec.credential_required
      ? credentialStatus
      : "not_required";

    // Per-source env keys still required to bring this source live.
    const needs_env_keys: string[] = [];
    if (spec.is_control_plane_source) {
      if (!flags.worker_enabled && spec.source_key !== "finances_api") {
        needs_env_keys.push("ENABLE_AMAZON_REPORTS_API_WORKER=true");
      }
      if (spec.worker_flag && !enabled) needs_env_keys.push(`${spec.worker_flag}=true`);
      if (!cronSecretPresent) needs_env_keys.push("CRON_SECRET=<secret>");
    }

    let freshness_status: DataSourceFreshness;
    if (!spec.worker_built && !spec.local_table) {
      freshness_status = "no_worker";
    } else if (probe.count === 0 || probe.count === null) {
      freshness_status = "empty";
    } else {
      const f = freshnessFromDate(probe.last_event_date, spec.stale_after_days);
      freshness_status = f;
    }

    const needs_initial_sync = spec.worker_built && enabled && (probe.count ?? 0) === 0;

    const badge = deriveDataSourceBadge({
      worker_flag: spec.worker_flag,
      enabled,
      live_sp_api_exists: liveSpApiExists,
      row_count: probe.count,
      freshness_status,
      credential_status,
      permission_status: "unknown",
      needs_env_keys,
      is_control_plane_source: spec.is_control_plane_source,
    });

    sources.push({
      source_key: spec.source_key,
      display_name: spec.display_name,
      source_domain: spec.source_domain,
      report_type_or_api_endpoint: spec.report_type_or_api_endpoint,
      enabled,
      worker_flag: spec.worker_flag,
      schedule: spec.schedule,
      last_run_at: run.last_at,
      next_run_at: null, // computed by scheduler when worker is enabled; not fabricated here
      last_success_at: run.last_success_at,
      last_error: run.error,
      row_count: probe.count,
      latest_event_date: probe.last_event_date,
      freshness_status,
      credential_status,
      permission_status: "unknown",
      live_sp_api_exists: liveSpApiExists,
      local_table: spec.local_table,
      claim_family_coverage: spec.claim_family_coverage,
      product_story_coverage: spec.product_story_coverage,
      needs_env_keys,
      needs_initial_sync,
      is_control_plane_source: spec.is_control_plane_source,
      badge,
    });
  }

  const filtered = filterDataSourcesForView(sources, view);

  const totals: DataSourcesHubTotals = {
    total_sources: filtered.length,
    live: filtered.filter((s) => s.badge === "live").length,
    local_only: filtered.filter((s) => s.badge === "local_only").length,
    disabled: filtered.filter((s) => s.badge === "disabled").length,
    needs_env: filtered.filter((s) => s.badge === "needs_env").length,
    needs_initial_sync: filtered.filter((s) => s.badge === "needs_initial_sync").length,
    stale: filtered.filter((s) => s.badge === "stale").length,
    healthy: filtered.filter((s) => s.badge === "healthy").length,
    missing_permission: filtered.filter((s) => s.badge === "missing_permission").length,
  };

  // Global env blockers (master flag + sub-flags + cron secret), de-duplicated.
  const missing_env_keys = Array.from(
    new Set([
      ...(!flags.worker_enabled ? ["ENABLE_AMAZON_REPORTS_API_WORKER=true"] : []),
      ...(!flags.reimbursements_enabled ? ["ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS=true"] : []),
      ...(!flags.settlement_enabled ? ["ENABLE_AMAZON_REPORTS_API_SETTLEMENT=true"] : []),
      ...(!flags.removal_order_enabled ? ["ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER=true"] : []),
      ...(!flags.removal_shipment_enabled ? ["ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT=true"] : []),
      ...(!flags.fba_returns_enabled ? ["ENABLE_AMAZON_REPORTS_API_FBA_RETURNS=true"] : []),
      ...(!flags.inventory_ledger_enabled ? ["ENABLE_AMAZON_REPORTS_API_INVENTORY_LEDGER=true"] : []),
      ...(!flags.fee_preview_enabled ? ["ENABLE_AMAZON_REPORTS_API_FEE_PREVIEW=true"] : []),
      ...(!flags.inbound_performance_enabled ? ["ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE=true"] : []),
      ...(!financesEnabled ? ["ENABLE_AMAZON_FINANCES_API_WORKER=true", "ENABLE_AMAZON_FINANCES_API_INGEST=true"] : []),
      ...(!cronSecretPresent ? ["CRON_SECRET=<secret>"] : []),
    ]),
  );

  const safe_to_run_initial_live_source_sync =
    missing_env_keys.length === 0 && credentialStatus === "present" && cronSecretPresent;

  return {
    version: DATA_SOURCES_HUB_V1,
    generated_at: new Date().toISOString(),
    organization_id: organizationId,
    store_id: options.storeId ?? null,
    view,
    sources: filtered,
    totals,
    missing_env_keys,
    cron_secret_present: cronSecretPresent,
    worker_master_enabled: flags.worker_enabled,
    safe_to_run_initial_live_source_sync,
  };
}
