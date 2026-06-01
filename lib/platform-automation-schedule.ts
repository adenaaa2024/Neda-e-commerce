import { readLegacyPlatformAutomationSettings } from "./platform-automation-scope-storage";
import {
  DEFAULT_API_CARD_SCHEDULE,
  DEFAULT_PLATFORM_AUTOMATION_SETTINGS,
  DEFAULT_STORE_AUTOMATION_SETTINGS,
  type ApiAutomationCardSchedule,
  type FinancesArchiveApiSchedule,
  type ManualWindowFields,
  type PlatformAutomationSettings,
  type ProductEnrichmentSchedule,
  type RemovalApiSyncSchedule,
  type RemovalHistoricalBackfillSchedule,
  type RemovalRecentSyncSchedule,
  type StoreAutomationSettings,
} from "./platform-automation-settings-types";

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function normalizeHours(raw: unknown, runsPerDay: number): number[] {
  const arr = Array.isArray(raw) ? raw : [];
  const hours = arr
    .map((h) => clampInt(h, 0, 23, NaN))
    .filter((h) => Number.isFinite(h));
  const unique = [...new Set(hours)].sort((a, b) => a - b);
  if (unique.length === 0) return [6];
  return unique.slice(0, Math.max(1, runsPerDay));
}

function normalizeRecentSync(raw: unknown): RemovalRecentSyncSchedule {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const runsPerDay = clampInt(src.runs_per_day, 1, 24, DEFAULT_PLATFORM_AUTOMATION_SETTINGS.removal_api_sync.recent_sync.runs_per_day);
  return {
    runs_per_day: runsPerDay,
    run_hours_utc: normalizeHours(src.run_hours_utc, runsPerDay),
    rolling_days: clampInt(
      src.rolling_days,
      1,
      90,
      DEFAULT_PLATFORM_AUTOMATION_SETTINGS.removal_api_sync.recent_sync.rolling_days,
    ),
    ...normalizeManualWindow(src),
  };
}

function normalizeHistorical(raw: unknown): RemovalHistoricalBackfillSchedule {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const keys = Array.isArray(src.window_keys)
    ? src.window_keys.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    : DEFAULT_PLATFORM_AUTOMATION_SETTINGS.removal_api_sync.historical_backfill.window_keys;
  return {
    enabled: src.enabled === true,
    runs_per_week: clampInt(src.runs_per_week, 1, 7, 1),
    run_day_of_week: clampInt(src.run_day_of_week, 0, 6, 0),
    run_hour_utc: clampInt(src.run_hour_utc, 0, 23, 4),
    window_keys: keys.length ? keys : ["nov_2025_w1"],
  };
}

function normalizeManualWindow(raw: unknown): ManualWindowFields {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const start = typeof src.manual_window_start === "string" ? src.manual_window_start.trim().slice(0, 10) : "";
  const end = typeof src.manual_window_end === "string" ? src.manual_window_end.trim().slice(0, 10) : "";
  return {
    manual_window_start: start || null,
    manual_window_end: end || null,
  };
}

function normalizeProductEnrichment(raw: unknown): ProductEnrichmentSchedule {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const runsPerDay = clampInt(
    src.runs_per_day,
    1,
    24,
    DEFAULT_PLATFORM_AUTOMATION_SETTINGS.product_enrichment.runs_per_day,
  );
  return {
    enabled: src.enabled === true,
    runs_per_day: runsPerDay,
    run_hours_utc: normalizeHours(src.run_hours_utc, runsPerDay),
    ...normalizeManualWindow(src),
  };
}

function normalizeApiCard(raw: unknown, fallback: ApiAutomationCardSchedule): ApiAutomationCardSchedule {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const runsPerDay = clampInt(src.runs_per_day, 1, 24, fallback.runs_per_day);
  return {
    enabled: src.enabled === true,
    runs_per_day: runsPerDay,
    run_hours_utc: normalizeHours(src.run_hours_utc, runsPerDay),
    rolling_days: clampInt(src.rolling_days, 1, 90, fallback.rolling_days),
    ...normalizeManualWindow(src),
  };
}

function normalizeFinancesArchive(raw: unknown): FinancesArchiveApiSchedule {
  const base = normalizeApiCard(raw, DEFAULT_STORE_AUTOMATION_SETTINGS.finances_archive_api);
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const mp = typeof src.marketplace_id === "string" ? src.marketplace_id.trim() : "";
  return {
    ...base,
    marketplace_id: mp || null,
  };
}

/** Parse + validate one org/store scope; never enables schedules unless explicitly true. */
export function normalizeStoreAutomationSettings(raw: unknown): StoreAutomationSettings {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    product_enrichment: normalizeProductEnrichment(src.product_enrichment),
    removal_api_sync: normalizeRemovalApiSync(src.removal_api_sync),
    reimbursements_api: normalizeApiCard(src.reimbursements_api, DEFAULT_STORE_AUTOMATION_SETTINGS.reimbursements_api),
    settlement_api: normalizeApiCard(src.settlement_api, DEFAULT_STORE_AUTOMATION_SETTINGS.settlement_api),
    finances_archive_api: normalizeFinancesArchive(src.finances_archive_api),
  };
}

function normalizeRemovalApiSync(raw: unknown): RemovalApiSyncSchedule {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: src.enabled === true,
    recent_sync: normalizeRecentSync(src.recent_sync),
    historical_backfill: normalizeHistorical(src.historical_backfill),
  };
}

/** Parse legacy flat settings for scheduler scripts (reads v2 scopes or legacy blob). */
export function normalizePlatformAutomationSettings(raw: unknown): PlatformAutomationSettings {
  return readLegacyPlatformAutomationSettings(raw);
}

/**
 * Next UTC run from daily hour list. Returns null when disabled or no hours.
 */
export function computeNextDailyRunUtc(
  enabled: boolean,
  runHoursUtc: number[],
  now: Date = new Date(),
): Date | null {
  if (!enabled) return null;
  const hours = [...new Set(runHoursUtc.map((h) => clampInt(h, 0, 23, 0)))].sort((a, b) => a - b);
  if (!hours.length) return null;

  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const todayStart = Date.UTC(y, m, d);

  for (const hour of hours) {
    const candidate = new Date(todayStart + hour * 3_600_000);
    if (candidate.getTime() > now.getTime()) return candidate;
  }

  const first = hours[0]!;
  return new Date(todayStart + 86_400_000 + first * 3_600_000);
}

/**
 * Next weekly UTC run (single slot). Returns null when disabled.
 */
export function computeNextWeeklyRunUtc(
  enabled: boolean,
  dayOfWeek: number,
  hourUtc: number,
  now: Date = new Date(),
): Date | null {
  if (!enabled) return null;
  const dow = clampInt(dayOfWeek, 0, 6, 0);
  const hour = clampInt(hourUtc, 0, 23, 0);

  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  const currentDow = cursor.getUTCDay();
  let deltaDays = (dow - currentDow + 7) % 7;
  if (deltaDays === 0 && cursor.getTime() <= now.getTime()) deltaDays = 7;
  cursor.setUTCDate(cursor.getUTCDate() + deltaDays);
  return cursor;
}

export function computeProductEnrichmentNextRun(
  schedule: ProductEnrichmentSchedule,
  now: Date = new Date(),
): Date | null {
  return computeNextDailyRunUtc(schedule.enabled, schedule.run_hours_utc, now);
}

export function computeRemovalRecentNextRun(
  schedule: RemovalApiSyncSchedule,
  now: Date = new Date(),
): Date | null {
  if (!schedule.enabled) return null;
  return computeNextDailyRunUtc(true, schedule.recent_sync.run_hours_utc, now);
}

export function computeRemovalHistoricalNextRun(
  schedule: RemovalApiSyncSchedule,
  now: Date = new Date(),
): Date | null {
  if (!schedule.enabled || !schedule.historical_backfill.enabled) return null;
  const hb = schedule.historical_backfill;
  return computeNextWeeklyRunUtc(true, hb.run_day_of_week, hb.run_hour_utc, now);
}

export function computeApiCardNextRun(
  schedule: ApiAutomationCardSchedule,
  now: Date = new Date(),
): Date | null {
  return computeNextDailyRunUtc(schedule.enabled, schedule.run_hours_utc, now);
}

/** True when any automation schedule would fire (used by schedulers — all off by default). */
export function isAnyAutomationScheduleEnabled(settings: PlatformAutomationSettings): boolean {
  return (
    settings.product_enrichment.enabled ||
    settings.removal_api_sync.enabled ||
    settings.removal_api_sync.historical_backfill.enabled
  );
}

export function isAnyStoreAutomationScheduleEnabled(settings: StoreAutomationSettings): boolean {
  return (
    isAnyAutomationScheduleEnabled({
      product_enrichment: settings.product_enrichment,
      removal_api_sync: settings.removal_api_sync,
    }) ||
    settings.reimbursements_api.enabled ||
    settings.settlement_api.enabled ||
    settings.finances_archive_api.enabled
  );
}

export function formatHoursUtcForInput(hours: number[]): string {
  return hours.map((h) => String(h).padStart(2, "0") + ":00").join(", ");
}

export function parseHoursUtcFromInput(text: string, runsPerDay: number): number[] {
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  const hours = parts.map((p) => {
    const m = p.match(/^(\d{1,2})(?::\d{2})?$/);
    return m ? clampInt(m[1], 0, 23, NaN) : NaN;
  });
  return normalizeHours(hours, runsPerDay);
}
