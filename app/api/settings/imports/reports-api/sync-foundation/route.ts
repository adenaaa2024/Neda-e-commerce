/**
 * GET /api/settings/imports/reports-api/sync-foundation
 *
 * PHASE-AMAZON-LIVE-REPORTS-FINANCES-SYNC-WORKERS-V1 — read-only status endpoint.
 *
 * Returns a per-source sync-foundation matrix covering all 8 Reports API workers
 * (4 existing + 4 new) plus the Finances API worker:
 *   - Worker and feature-flag status
 *   - SP-API report type + route
 *   - Domain table + row count + last event date + freshness
 *   - live_sp_api_exists (worker code built + flag enabled)
 *   - Last source run from raw_report_uploads
 *
 * No credentials, no claim mutation, no Amazon calls.
 * Query: ?organization_id= (required)
 */
import { NextResponse } from "next/server";

import { isAmazonFinancesApiWorkerEnabled } from "@/lib/amazon/finances-api-worker-flags";
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
import { allReportsApiWorkerFlags } from "@/lib/amazon/reports-api-worker-flags";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";

type SourceSyncRow = {
  source_key: string;
  label: string;
  sp_api_report_type: string | null;
  sp_api_type_label: string;
  domain_table: string;
  run_route: string | null;
  resume_route: string | null;
  worker_built: boolean;
  flag_env_key: string | null;
  flag_enabled: boolean;
  live_sp_api_exists: boolean;
  row_count: number | null;
  last_event_date: string | null;
  freshness_status: "fresh" | "stale" | "empty" | "no_worker" | "unknown";
  last_source_run_at: string | null;
  last_source_run_state: string | null;
  last_source_run_error: string | null;
  notes: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function freshnessFromDate(dateStr: string | null, staleAfterDays: number): "fresh" | "stale" | "unknown" {
  if (!dateStr) return "unknown";
  const age = (Date.now() - new Date(dateStr).getTime()) / DAY_MS;
  return age <= staleAfterDays ? "fresh" : "stale";
}

async function probeTable(
  orgId: string,
  table: string,
  dateCols: string[],
): Promise<{ count: number | null; last_event_date: string | null }> {
  const countQ = await supabaseServer
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (countQ.error) return { count: null, last_event_date: null };
  const count = countQ.count ?? 0;

  for (const col of dateCols) {
    const dq = await supabaseServer
      .from(table)
      .select(col)
      .eq("organization_id", orgId)
      .not(col, "is", null)
      .order(col, { ascending: false })
      .limit(1);
    if (!dq.error && dq.data?.[0]) {
      const v = (dq.data[0] as unknown as Record<string, unknown>)[col];
      if (typeof v === "string") return { count, last_event_date: v };
    }
  }
  return { count, last_event_date: null };
}

async function lastSourceRun(
  orgId: string,
  reportType: string,
): Promise<{ last_at: string | null; state: string | null; error: string | null }> {
  const q = await supabaseServer
    .from("raw_report_uploads")
    .select("created_at, metadata")
    .eq("organization_id", orgId)
    .eq("report_type", reportType)
    .order("created_at", { ascending: false })
    .limit(1);
  if (q.error || !q.data?.[0]) return { last_at: null, state: null, error: null };
  const row = q.data[0] as { created_at: string; metadata?: unknown };
  const meta = row.metadata as Record<string, unknown> | null | undefined;
  const sr = meta?.source_run as Record<string, unknown> | null | undefined;
  const attempt = sr?.attempt as Record<string, unknown> | null | undefined;
  return {
    last_at: row.created_at,
    state: typeof sr?.state === "string" ? sr.state : null,
    error: typeof attempt?.last_error_code === "string" ? attempt.last_error_code : null,
  };
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const organizationId = url.searchParams.get("organization_id")?.trim() ?? "";

  if (!isUuidString(organizationId)) {
    return NextResponse.json(
      { ok: false, error: "organization_id is required and must be a valid UUID." },
      { status: 400 },
    );
  }

  const flags = allReportsApiWorkerFlags();
  const financesEnabled = isAmazonFinancesApiWorkerEnabled();

  type SourceSpec = {
    source_key: string;
    label: string;
    sp_api_report_type: string | null;
    sp_api_type_label: string;
    domain_table: string;
    date_cols: string[];
    run_route: string | null;
    resume_route: string | null;
    worker_built: boolean;
    flag_env_key: string | null;
    flag_enabled: boolean;
    stale_after_days: number;
    notes: string;
  };

  const sources: SourceSpec[] = [
    {
      source_key: "settlement",
      label: "Settlement Flat File V2",
      sp_api_report_type: SP_API_REPORT_TYPE_SETTLEMENT_V2,
      sp_api_type_label: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
      domain_table: "amazon_settlements",
      date_cols: ["posted_date", "settlement_start_date", "created_at"],
      run_route: "/api/settings/imports/reports-api/settlement/run",
      resume_route: "/api/settings/imports/reports-api/settlement/resume",
      worker_built: true,
      flag_env_key: "ENABLE_AMAZON_REPORTS_API_SETTLEMENT",
      flag_enabled: flags.settlement_enabled,
      stale_after_days: 14,
      notes: "Order rows with product_sales required for latest-sale-net. List mode (scheduled_list).",
    },
    {
      source_key: "reimbursements",
      label: "FBA Reimbursements",
      sp_api_report_type: SP_API_REPORT_TYPE_REIMBURSEMENTS,
      sp_api_type_label: "GET_FBA_REIMBURSEMENTS_DATA",
      domain_table: "amazon_reimbursements",
      date_cols: ["approval_date", "reimbursement_date", "created_at"],
      run_route: "/api/settings/imports/reports-api/run",
      resume_route: "/api/settings/imports/reports-api/resume",
      worker_built: true,
      flag_env_key: "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS",
      flag_enabled: flags.reimbursements_enabled,
      stale_after_days: 14,
      notes: "Order-linked rows required to confirm unpaid reimbursements.",
    },
    {
      source_key: "removal_order",
      label: "Removal Order Detail",
      sp_api_report_type: SP_API_REPORT_TYPE_REMOVAL_ORDER,
      sp_api_type_label: "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA",
      domain_table: "amazon_removals",
      date_cols: ["order_date", "request_date", "created_at"],
      run_route: "/api/settings/imports/reports-api/removal-order/run",
      resume_route: "/api/settings/imports/reports-api/removal-order/resume",
      worker_built: true,
      flag_env_key: "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
      flag_enabled: flags.removal_order_enabled,
      stale_after_days: 3,
      notes: "Removal delivery/completion proof for claim gate. Fetch-only by default; resume runs pipeline.",
    },
    {
      source_key: "removal_shipment",
      label: "Removal Shipment Detail",
      sp_api_report_type: SP_API_REPORT_TYPE_REMOVAL_SHIPMENT,
      sp_api_type_label: "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA",
      domain_table: "amazon_removal_shipments",
      date_cols: ["shipment_date", "request_date", "created_at"],
      run_route: "/api/settings/imports/reports-api/removal-shipment/run",
      resume_route: "/api/settings/imports/reports-api/removal-shipment/resume",
      worker_built: true,
      flag_env_key: "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
      flag_enabled: flags.removal_shipment_enabled,
      stale_after_days: 3,
      notes: "Tracking/shipment proof for removal claims. Builds expected_packages tree on import.",
    },
    {
      source_key: "fba_returns",
      label: "FBA Customer Returns",
      sp_api_report_type: SP_API_REPORT_TYPE_FBA_RETURNS,
      sp_api_type_label: "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA",
      domain_table: "amazon_returns",
      date_cols: ["return_date", "created_at"],
      run_route: "/api/settings/imports/reports-api/fba-returns/run",
      resume_route: "/api/settings/imports/reports-api/fba-returns/resume",
      worker_built: true,
      flag_env_key: "ENABLE_AMAZON_REPORTS_API_FBA_RETURNS",
      flag_enabled: flags.fba_returns_enabled,
      stale_after_days: 7,
      notes: "Customer return proof for customer_return_not_reimbursed + refund_without_return families.",
    },
    {
      source_key: "inventory_ledger",
      label: "Inventory Ledger (Detail View)",
      sp_api_report_type: SP_API_REPORT_TYPE_INVENTORY_LEDGER,
      sp_api_type_label: "GET_LEDGER_DETAIL_VIEW_DATA",
      domain_table: "amazon_inventory_ledger",
      date_cols: ["event_date", "date", "created_at"],
      run_route: "/api/settings/imports/reports-api/inventory-ledger/run",
      resume_route: "/api/settings/imports/reports-api/inventory-ledger/resume",
      worker_built: true,
      flag_env_key: "ENABLE_AMAZON_REPORTS_API_INVENTORY_LEDGER",
      flag_enabled: flags.inventory_ledger_enabled,
      stale_after_days: 7,
      notes: "Detail View required (not Daily Summary). Unlocks warehouse_lost/damaged/disposed claim families.",
    },
    {
      source_key: "fee_preview",
      label: "FBA Fee Preview",
      sp_api_report_type: SP_API_REPORT_TYPE_FEE_PREVIEW,
      sp_api_type_label: "GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA",
      domain_table: "amazon_fee_preview",
      date_cols: ["created_at"],
      run_route: "/api/settings/imports/reports-api/fee-preview/run",
      resume_route: "/api/settings/imports/reports-api/fee-preview/resume",
      worker_built: true,
      flag_env_key: "ENABLE_AMAZON_REPORTS_API_FEE_PREVIEW",
      flag_enabled: flags.fee_preview_enabled,
      stale_after_days: 30,
      notes: "FBA fee estimates for fee overcharge claims. Weekly cadence recommended.",
    },
    {
      source_key: "inbound_performance",
      label: "Inbound Shipment Performance",
      sp_api_report_type: SP_API_REPORT_TYPE_INBOUND_PERFORMANCE,
      sp_api_type_label: "GET_FBA_FULFILLMENT_INBOUND_PERFORMANCE_DATA",
      domain_table: "amazon_inbound_performance",
      date_cols: ["created_at"],
      run_route: "/api/settings/imports/reports-api/inbound-performance/run",
      resume_route: "/api/settings/imports/reports-api/inbound-performance/resume",
      worker_built: true,
      flag_env_key: "ENABLE_AMAZON_REPORTS_API_INBOUND_PERFORMANCE",
      flag_enabled: flags.inbound_performance_enabled,
      stale_after_days: 7,
      notes: "FBA inbound shipment discrepancy data. Unlocks inbound_shipment_shortage claim family.",
    },
    {
      source_key: "finances_api",
      label: "Finances API (financial events)",
      sp_api_report_type: null,
      sp_api_type_label: "listFinancialEventGroups / listFinancialEventsByGroup",
      domain_table: "amazon_finances_events",
      date_cols: ["posted_date", "created_at"],
      run_route: "/api/settings/imports/finances-api/run",
      resume_route: "/api/settings/imports/finances-api/resume",
      worker_built: true,
      flag_env_key: "ENABLE_AMAZON_FINANCES_API_WORKER",
      flag_enabled: financesEnabled,
      stale_after_days: 7,
      notes: "Financial events for reimbursement reversal + settlement refund anomaly families.",
    },
  ];

  const matrix: SourceSyncRow[] = [];
  for (const s of sources) {
    const { count, last_event_date } = await probeTable(organizationId, s.domain_table, s.date_cols);
    const { last_at, state, error: runError } = s.sp_api_report_type
      ? await lastSourceRun(organizationId, s.sp_api_report_type)
      : { last_at: null, state: null, error: null };

    const live_sp_api_exists = s.worker_built && s.flag_enabled;

    let freshness_status: SourceSyncRow["freshness_status"];
    if (!s.worker_built) {
      freshness_status = "no_worker";
    } else if (count === 0 || count === null) {
      freshness_status = "empty";
    } else {
      const f = freshnessFromDate(last_event_date, s.stale_after_days);
      freshness_status = f === "unknown" ? "unknown" : f;
    }

    matrix.push({
      source_key: s.source_key,
      label: s.label,
      sp_api_report_type: s.sp_api_report_type,
      sp_api_type_label: s.sp_api_type_label,
      domain_table: s.domain_table,
      run_route: s.run_route,
      resume_route: s.resume_route,
      worker_built: s.worker_built,
      flag_env_key: s.flag_env_key,
      flag_enabled: s.flag_enabled,
      live_sp_api_exists,
      row_count: count,
      last_event_date,
      freshness_status,
      last_source_run_at: last_at,
      last_source_run_state: state,
      last_source_run_error: runError,
      notes: s.notes,
    });
  }

  const missing_env_keys = [
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
    ...(!(process.env.CRON_SECRET?.trim()) ? ["CRON_SECRET=<secret>"] : []),
    ...(!(process.env.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON?.trim()) ? ["ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON=true (for Vercel removal cron)"] : []),
  ];

  const workers_live = matrix.filter((r) => r.live_sp_api_exists).length;
  const workers_built_but_disabled = matrix.filter((r) => r.worker_built && !r.flag_enabled).length;
  const sources_fresh = matrix.filter((r) => r.freshness_status === "fresh").length;
  const sources_stale = matrix.filter((r) => r.freshness_status === "stale").length;
  const sources_empty = matrix.filter((r) => r.freshness_status === "empty").length;

  return NextResponse.json({
    ok: true,
    version: "PHASE-AMAZON-LIVE-REPORTS-FINANCES-SYNC-WORKERS-V1",
    organization_id: organizationId,
    generated_at: new Date().toISOString(),

    worker_flags: flags,
    finances_worker_enabled: financesEnabled,
    cron_secret_present: Boolean(process.env.CRON_SECRET?.trim()),
    production_removal_cron_enabled: Boolean(
      process.env.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON?.trim(),
    ),

    missing_env_keys,

    totals: {
      total_sources: matrix.length,
      workers_built: matrix.filter((r) => r.worker_built).length,
      workers_live,
      workers_built_but_disabled,
      sources_fresh,
      sources_stale,
      sources_empty,
    },

    source_sync_worker_matrix: matrix,

    report_types_supported: matrix
      .filter((r) => r.sp_api_report_type && r.worker_built)
      .map((r) => r.sp_api_report_type),

    api_endpoints_supported: matrix.filter((r) => r.worker_built).map((r) => r.run_route),

    SAFE_LIVE_REPORTS_FINANCES_SYNC_FOUNDATION_READY: missing_env_keys.length === 0,
    SAFE_TO_RUN_INITIAL_LIVE_SOURCE_SYNC: flags.worker_enabled,
    SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES: true,
  });
}
