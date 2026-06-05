/**
 * Server-side manual run environment hints for Automation UI (no secrets exposed).
 */
import { readPlatformAutomationApiFlags } from "./platform-automation-api-flags";
import { PRODUCTION_REF } from "./production-db-bind";
import { refFromSupabaseUrl } from "./staging-project-ref";

export type AutomationRunEnvironment = {
  reports_api_worker_enabled: boolean;
  production_db_configured: boolean;
  cron_secret_configured: boolean;
  original_postgres_configured: boolean;
  vercel_cron_tier: "hobby" | "pro";
  manual_run_may_queue_only: boolean;
  local_warning: string | null;
};

export function resolveAutomationVercelCronTier(): "hobby" | "pro" {
  const raw =
    process.env.AUTOMATION_VERCEL_CRON_TIER?.trim().toLowerCase() ??
    process.env.NEXT_PUBLIC_AUTOMATION_VERCEL_CRON_TIER?.trim().toLowerCase() ??
    "hobby";
  return raw === "pro" ? "pro" : "hobby";
}

export function buildAutomationRunEnvironment(): AutomationRunEnvironment {
  const flags = readPlatformAutomationApiFlags();
  const urlRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  const productionDb = urlRef === PRODUCTION_REF;
  const cronSecret = Boolean(process.env.CRON_SECRET?.trim());
  const originalPg = Boolean(
    process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim()?.includes(PRODUCTION_REF) ||
      process.env.DIRECT_POSTGRES_URL?.trim()?.includes(PRODUCTION_REF),
  );

  const missing: string[] = [];
  if (!flags.reports_worker_enabled) missing.push("ENABLE_AMAZON_REPORTS_API_WORKER");
  if (!productionDb) missing.push("production Supabase URL");
  if (!originalPg) missing.push("ORIGINAL_DIRECT_POSTGRES_URL");
  if (!cronSecret) missing.push("CRON_SECRET");

  let local_warning: string | null = null;
  if (missing.length) {
    local_warning =
      "Local/dev server: manual Run now may only queue SP-API work (HTTP 202) or dry-run. " +
      `Missing or non-production: ${missing.join(", ")}. ` +
      "This does not mean production cron ran.";
  }

  return {
    reports_api_worker_enabled: flags.reports_worker_enabled,
    production_db_configured: productionDb,
    cron_secret_configured: cronSecret,
    original_postgres_configured: originalPg,
    vercel_cron_tier: resolveAutomationVercelCronTier(),
    manual_run_may_queue_only: missing.length > 0 || !flags.reports_worker_enabled,
    local_warning,
  };
}
