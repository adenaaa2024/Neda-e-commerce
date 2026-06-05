import type { SupabaseClient } from "@supabase/supabase-js";

import { pickHealthImportRow, type HealthImportRow } from "./command-center-health";
import { PRODUCTION_ORG_ID, PRODUCTION_STORE_ID } from "./production-removal-sync-run";
import { readStoreAutomationSettings } from "./platform-automation-scope-storage";
import { computeRemovalRecentNextRun } from "./platform-automation-schedule";
import { VERCEL_REMOVAL_CRON_WAKE_SCHEDULE } from "./removal-cron-schedule-gate";

const REMOVAL_TYPES = ["REMOVAL_ORDER", "REMOVAL_SHIPMENT"] as const;

export type ProductionSyncHealth = {
  last_successful_removal_import_at: string | null;
  last_successful_removal_import_type: string | null;
  last_failed_removal_import_at: string | null;
  last_failed_removal_import_type: string | null;
  latest_shipment_date: string | null;
  latest_removal_order_date: string | null;
  expected_packages_derived_count: number | null;
  expected_packages_unresolved_count: number | null;
  next_scheduled_run_at: string | null;
  schedule_source: string;
  vercel_wake_schedule: string;
  last_cron_success_at: string | null;
  last_cron_failed_at: string | null;
  last_cron_status: string | null;
  /** @deprecated Use vercel_wake_schedule */
  cron_schedule: string;
  /** @deprecated Use next_scheduled_run_at */
  next_scheduled_cron_utc: string;
};

/** @deprecated Hardcoded business schedule removed — use platform settings. */
export const REMOVAL_NIGHTLY_CRON_UTC = VERCEL_REMOVAL_CRON_WAKE_SCHEDULE;

export async function loadProductionSyncHealth(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ProductionSyncHealth> {
  const { data: psRow } = await supabase
    .from("platform_settings")
    .select("automation_settings")
    .eq("id", true)
    .maybeSingle();

  const storeSettings = readStoreAutomationSettings(
    (psRow as { automation_settings?: unknown } | null)?.automation_settings,
    organizationId === PRODUCTION_ORG_ID ? PRODUCTION_ORG_ID : organizationId,
    PRODUCTION_STORE_ID,
  );
  const removal = storeSettings.removal_api_sync;
  const cronRt = removal.cron_runtime;
  const nextFromSettings = computeRemovalRecentNextRun(removal)?.toISOString() ?? null;
  const next_scheduled_run_at = cronRt?.next_run_at ?? nextFromSettings;

  const { data: imports } = await supabase
    .from("raw_report_uploads")
    .select("created_at, report_type, status")
    .eq("organization_id", organizationId)
    .in("report_type", [...REMOVAL_TYPES])
    .order("created_at", { ascending: false })
    .limit(40);

  const rows = (imports ?? []) as HealthImportRow[];
  const success = rows.find((r) => {
    const s = String(r.status ?? "");
    return s && !/fail|error/i.test(s) && s !== "archived_health_demo";
  });
  const failedCandidate = rows.find((r) => /fail|error/i.test(String(r.status ?? "")));
  const failed =
    failedCandidate &&
    (!success?.created_at ||
      !failedCandidate.created_at ||
      failedCandidate.created_at > success.created_at)
      ? failedCandidate
      : null;

  const { data: shipMax } = await supabase
    .from("amazon_removal_shipments")
    .select("shipment_date")
    .eq("organization_id", organizationId)
    .not("shipment_date", "is", null)
    .order("shipment_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: orderMax } = await supabase
    .from("amazon_removals")
    .select("order_date")
    .eq("organization_id", organizationId)
    .not("order_date", "is", null)
    .order("order_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { count: epDerived } = await supabase
    .from("expected_packages")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("build_source", ["detail_shipment", "detail_remainder"]);

  const { count: epUnresolved } = await supabase
    .from("expected_packages")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("build_source", ["detail_shipment", "detail_remainder"])
    .is("resolved_product_id", null);

  pickHealthImportRow(rows);

  return {
    last_successful_removal_import_at: cronRt?.last_success_at ?? success?.created_at ?? null,
    last_successful_removal_import_type: success?.report_type ?? null,
    last_failed_removal_import_at: cronRt?.last_failed_at ?? failed?.created_at ?? null,
    last_failed_removal_import_type: failed?.report_type ?? null,
    latest_shipment_date: (shipMax as { shipment_date?: string } | null)?.shipment_date ?? null,
    latest_removal_order_date: (orderMax as { order_date?: string } | null)?.order_date ?? null,
    expected_packages_derived_count: epDerived ?? null,
    expected_packages_unresolved_count: epUnresolved ?? null,
    next_scheduled_run_at,
    schedule_source: "platform_settings.automation_settings.removal_api_sync",
    vercel_wake_schedule: VERCEL_REMOVAL_CRON_WAKE_SCHEDULE,
    last_cron_success_at: cronRt?.last_success_at ?? null,
    last_cron_failed_at: cronRt?.last_failed_at ?? null,
    last_cron_status: cronRt?.last_run_status ?? null,
    cron_schedule: VERCEL_REMOVAL_CRON_WAKE_SCHEDULE,
    next_scheduled_cron_utc: next_scheduled_run_at ?? "",
  };
}
