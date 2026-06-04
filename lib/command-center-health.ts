import type { SupabaseClient } from "@supabase/supabase-js";

import { readStoreAutomationSettings } from "./platform-automation-scope-storage";

const DEFAULT_STORE_ID = process.env.NEXT_PUBLIC_STORE_ID?.trim() || "509ee1f6-622c-46a5-8110-7b889ba46c2c";

export type HealthImportRow = {
  created_at?: string;
  report_type?: string;
  status?: string;
};

/** Prefer latest non-failed import for dashboard health (skip stale error rows). */
export function pickHealthImportRow(rows: HealthImportRow[] | null | undefined): HealthImportRow | null {
  if (!rows?.length) return null;
  for (const row of rows) {
    const status = String(row.status ?? "").trim();
    if (!status) return row;
    if (/fail|error/i.test(status)) continue;
    if (status === "archived_health_demo") continue;
    return row;
  }
  return rows[0] ?? null;
}

export function healthImportErrorsHint(status: string | null | undefined): string | null {
  const s = status?.trim();
  if (!s || !/fail|error/i.test(s)) return null;
  return `Last import status: ${s}`;
}

export async function resolveProductJobHealthFallback(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ status: string | null; at: string | null }> {
  const { data, error } = await supabase
    .from("platform_settings")
    .select("automation_settings")
    .eq("id", true)
    .maybeSingle();
  if (error || !data) return { status: null, at: null };

  const settings = readStoreAutomationSettings(
    (data as { automation_settings?: unknown }).automation_settings,
    organizationId,
    DEFAULT_STORE_ID,
  );
  if (settings.product_enrichment.enabled) {
    const runs = settings.product_enrichment.runs_per_day;
    return {
      status: runs > 0 ? `scheduled (${runs}/day)` : "configured",
      at: null,
    };
  }
  return { status: "idle", at: null };
}

export function isBackgroundJobsProbeError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("background_jobs") && (m.includes("does not exist") || m.includes("pgrst205"));
}
