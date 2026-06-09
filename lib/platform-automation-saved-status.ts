import {
  computeApiCardNextRun,
  computeProductEnrichmentNextRun,
  computeRemovalHistoricalNextRun,
  computeRemovalRecentNextRun,
  normalizeStoreAutomationSettings,
} from "./platform-automation-schedule";
import type {
  StoreAutomationSettings,
  StoreAutomationSettingsView,
} from "./platform-automation-settings-types";

export function storeSettingsFromView(
  view: StoreAutomationSettingsView | null | undefined,
): StoreAutomationSettings | null {
  if (!view) return null;
  return normalizeStoreAutomationSettings({
    product_enrichment: view.product_enrichment,
    removal_api_sync: view.removal_api_sync,
    reimbursements_api: view.reimbursements_api,
    settlement_api: view.settlement_api,
    finances_archive_api: view.finances_archive_api,
  });
}

export function storeAutomationSettingsEqual(
  a: StoreAutomationSettings | null | undefined,
  b: StoreAutomationSettings | null | undefined,
): boolean {
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function parseRuntimeNextRun(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Prefer persisted runtime next_run_at; fall back to schedule computation. */
export function resolveDisplayNextRun(args: {
  scheduleEnabled: boolean;
  runtimeNextAt: string | null | undefined;
  computedNext: Date | null;
}): Date | null {
  if (!args.scheduleEnabled) return null;
  return parseRuntimeNextRun(args.runtimeNextAt) ?? args.computedNext;
}

export type RemovalRunSource = "cron" | "manual" | "unknown";

export function inferRemovalRunSource(view: StoreAutomationSettingsView | null | undefined): RemovalRunSource {
  if (!view) return "unknown";
  const cron = view.removal_api_sync.cron_runtime;
  const recent = view.runtime?.removal_api_sync?.recent;
  const hasManual =
    Boolean(view.manual_runs?.removal_order?.upload_id) ||
    Boolean(view.manual_runs?.removal_shipment?.upload_id);
  if (cron?.last_slot_key && cron.last_run_at) return "cron";
  if (cron?.last_run_at && recent?.last_run_at === cron.last_run_at) return "cron";
  if (hasManual && recent?.last_run_at) return "manual";
  if (cron?.last_run_at) return "cron";
  return "unknown";
}

export type SavedScheduleNextRuns = {
  product: Date | null;
  removal: Date | null;
  historical: Date | null;
  reimbursements: Date | null;
  settlement: Date | null;
  finances: Date | null;
};

export function computeSavedScheduleNextRuns(
  view: StoreAutomationSettingsView | null | undefined,
  now: Date = new Date(),
): SavedScheduleNextRuns | null {
  const saved = storeSettingsFromView(view);
  if (!saved || !view) return null;
  const rt = view.runtime;
  return {
    product: resolveDisplayNextRun({
      scheduleEnabled: saved.product_enrichment.enabled,
      runtimeNextAt: rt.product_enrichment.next_run_at,
      computedNext: computeProductEnrichmentNextRun(saved.product_enrichment, now),
    }),
    removal: resolveDisplayNextRun({
      scheduleEnabled: saved.removal_api_sync.enabled,
      runtimeNextAt: rt.removal_api_sync.recent.next_run_at,
      computedNext:
        parseRuntimeNextRun(view.removal_api_sync.cron_runtime?.next_run_at) ??
        computeRemovalRecentNextRun(saved.removal_api_sync, now),
    }),
    historical: resolveDisplayNextRun({
      scheduleEnabled:
        saved.removal_api_sync.enabled && saved.removal_api_sync.historical_backfill.enabled,
      runtimeNextAt: rt.removal_api_sync.historical_backfill.next_run_at,
      computedNext: computeRemovalHistoricalNextRun(saved.removal_api_sync, now),
    }),
    reimbursements: resolveDisplayNextRun({
      scheduleEnabled: saved.reimbursements_api.enabled,
      runtimeNextAt:
        saved.reimbursements_api.cron_runtime?.next_run_at ?? rt.reimbursements_api.next_run_at,
      computedNext: computeApiCardNextRun(saved.reimbursements_api, now),
    }),
    settlement: resolveDisplayNextRun({
      scheduleEnabled: saved.settlement_api.enabled,
      runtimeNextAt: saved.settlement_api.cron_runtime?.next_run_at ?? rt.settlement_api.next_run_at,
      computedNext: computeApiCardNextRun(saved.settlement_api, now),
    }),
    finances: resolveDisplayNextRun({
      scheduleEnabled: saved.finances_archive_api.enabled,
      runtimeNextAt:
        saved.finances_archive_api.cron_runtime?.next_run_at ?? rt.finances_archive_api.next_run_at,
      computedNext: computeApiCardNextRun(saved.finances_archive_api, now),
    }),
  };
}
