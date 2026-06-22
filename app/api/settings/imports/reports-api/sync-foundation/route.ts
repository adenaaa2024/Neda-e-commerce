/**
 * GET /api/settings/imports/reports-api/sync-foundation
 *
 * PHASE-AMAZON-LIVE-REPORTS-FINANCES-SYNC-WORKERS-V1 — read-only status endpoint.
 * PHASE-DATA-SOURCES-HUB-AND-CLAIM-CENTER-NAV-UNIFICATION-V1 — now DELEGATES to
 * the single `composeDataSourcesHubStatusV1` composer so Settings / API cards
 * and the sync-foundation matrix share ONE definition of source status. This
 * route maps the hub rows back to the legacy `source_sync_worker_matrix` shape
 * (adding run/resume route metadata) for backward compatibility.
 *
 * No credentials, no claim mutation, no Amazon calls.
 * Query: ?organization_id= (required)
 */
import { NextResponse } from "next/server";

import { composeDataSourcesHubStatusV1 } from "@/lib/data-sources/data-sources-hub-v1";
import { isAmazonFinancesApiWorkerEnabled } from "@/lib/amazon/finances-api-worker-flags";
import { allReportsApiWorkerFlags } from "@/lib/amazon/reports-api-worker-flags";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";

/** Run/resume routes per hub source_key (metadata not carried by the hub). */
const SOURCE_ROUTES: Record<string, { run: string | null; resume: string | null; label: string }> = {
  settlement: {
    run: "/api/settings/imports/reports-api/settlement/run",
    resume: "/api/settings/imports/reports-api/settlement/resume",
    label: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
  },
  reimbursements: {
    run: "/api/settings/imports/reports-api/run",
    resume: "/api/settings/imports/reports-api/resume",
    label: "GET_FBA_REIMBURSEMENTS_DATA",
  },
  removal_order: {
    run: "/api/settings/imports/reports-api/removal-order/run",
    resume: "/api/settings/imports/reports-api/removal-order/resume",
    label: "GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA",
  },
  removal_shipment: {
    run: "/api/settings/imports/reports-api/removal-shipment/run",
    resume: "/api/settings/imports/reports-api/removal-shipment/resume",
    label: "GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA",
  },
  fba_returns: {
    run: "/api/settings/imports/reports-api/fba-returns/run",
    resume: "/api/settings/imports/reports-api/fba-returns/resume",
    label: "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA",
  },
  inventory_ledger: {
    run: "/api/settings/imports/reports-api/inventory-ledger/run",
    resume: "/api/settings/imports/reports-api/inventory-ledger/resume",
    label: "GET_LEDGER_DETAIL_VIEW_DATA",
  },
  fee_preview: {
    run: "/api/settings/imports/reports-api/fee-preview/run",
    resume: "/api/settings/imports/reports-api/fee-preview/resume",
    label: "GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA",
  },
  inbound_performance: {
    run: "/api/settings/imports/reports-api/inbound-performance/run",
    resume: "/api/settings/imports/reports-api/inbound-performance/resume",
    label: "GET_FBA_FULFILLMENT_INBOUND_PERFORMANCE_DATA",
  },
  finances_api: {
    run: "/api/settings/imports/finances-api/run",
    resume: "/api/settings/imports/finances-api/resume",
    label: "listFinancialEventGroups / listFinancialEventsByGroup",
  },
};

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

  // Single source of truth — control-plane view only includes connector sources here.
  const hub = await composeDataSourcesHubStatusV1(supabaseServer, organizationId, { view: "control_plane" });
  const connectorRows = hub.sources.filter((s) => s.is_control_plane_source);

  const matrix = connectorRows.map((s) => {
    const routes = SOURCE_ROUTES[s.source_key] ?? { run: null, resume: null, label: s.report_type_or_api_endpoint };
    return {
      source_key: s.source_key,
      label: s.display_name,
      sp_api_report_type: s.report_type_or_api_endpoint.startsWith("list") ? null : s.report_type_or_api_endpoint,
      sp_api_type_label: routes.label,
      domain_table: s.local_table,
      run_route: routes.run,
      resume_route: routes.resume,
      worker_built: true,
      flag_env_key: s.worker_flag,
      flag_enabled: s.enabled,
      live_sp_api_exists: s.live_sp_api_exists,
      row_count: s.row_count,
      last_event_date: s.latest_event_date,
      freshness_status: s.freshness_status,
      last_source_run_at: s.last_run_at,
      last_source_run_state: s.last_success_at ? "succeeded" : s.last_run_at ? "ran" : null,
      last_source_run_error: s.last_error,
      badge: s.badge,
      notes: s.report_type_or_api_endpoint,
    };
  });

  const workers_live = matrix.filter((r) => r.live_sp_api_exists).length;
  const workers_built_but_disabled = matrix.filter((r) => r.worker_built && !r.flag_enabled).length;
  const sources_fresh = matrix.filter((r) => r.freshness_status === "fresh").length;
  const sources_stale = matrix.filter((r) => r.freshness_status === "stale").length;
  const sources_empty = matrix.filter((r) => r.freshness_status === "empty").length;

  return NextResponse.json({
    ok: true,
    version: "PHASE-AMAZON-LIVE-REPORTS-FINANCES-SYNC-WORKERS-V1",
    source_of_truth: "composeDataSourcesHubStatusV1",
    organization_id: organizationId,
    generated_at: hub.generated_at,

    worker_flags: flags,
    finances_worker_enabled: financesEnabled,
    cron_secret_present: hub.cron_secret_present,
    production_removal_cron_enabled: Boolean(process.env.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON?.trim()),

    missing_env_keys: hub.missing_env_keys,

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

    SAFE_LIVE_REPORTS_FINANCES_SYNC_FOUNDATION_READY: hub.missing_env_keys.length === 0,
    SAFE_TO_RUN_INITIAL_LIVE_SOURCE_SYNC: hub.safe_to_run_initial_live_source_sync,
    SAFE_TO_REBUILD_CLAIM_CANDIDATE_GATES: true,
  });
}
