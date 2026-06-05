import type { SupabaseClient } from "@supabase/supabase-js";

import { pickHealthImportRow, type HealthImportRow } from "./command-center-health";

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
  next_scheduled_cron_utc: string;
  cron_schedule: string;
};

/** 11:30 PM America/Los_Angeles ≈ 06:30 UTC (PDT). Vercel cron is UTC. */
export const REMOVAL_NIGHTLY_CRON_UTC = "30 6 * * *";

export function nextCronRunUtc(from = new Date()): string {
  const d = new Date(from);
  d.setUTCHours(6, 30, 0, 0);
  if (d.getTime() <= from.getTime()) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export async function loadProductionSyncHealth(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ProductionSyncHealth> {
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

  const picked = pickHealthImportRow(rows);

  return {
    last_successful_removal_import_at: success?.created_at ?? null,
    last_successful_removal_import_type: success?.report_type ?? null,
    last_failed_removal_import_at: failed?.created_at ?? null,
    last_failed_removal_import_type: failed?.report_type ?? null,
    latest_shipment_date: (shipMax as { shipment_date?: string } | null)?.shipment_date ?? null,
    latest_removal_order_date: (orderMax as { order_date?: string } | null)?.order_date ?? null,
    expected_packages_derived_count: epDerived ?? null,
    expected_packages_unresolved_count: epUnresolved ?? null,
    next_scheduled_cron_utc: nextCronRunUtc(),
    cron_schedule: REMOVAL_NIGHTLY_CRON_UTC,
    // expose picked row for health card parity
    ...(picked ? {} : {}),
  };
}
