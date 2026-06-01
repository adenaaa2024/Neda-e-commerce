import {
  computeApiCardNextRun,
  computeProductEnrichmentNextRun,
  computeRemovalHistoricalNextRun,
  computeRemovalRecentNextRun,
  normalizePlatformAutomationSettings,
  normalizeStoreAutomationSettings,
} from "./platform-automation-schedule";
import type { PlatformAutomationSettings, StoreAutomationSettings } from "./platform-automation-settings-types";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** User-facing status label (no raw enum strings). */
export function formatAutomationStatusLabel(status: string): string {
  switch (status) {
    case "never":
      return "Not run yet";
    case "success":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "partial":
      return "Partial";
    default:
      return status.replace(/_/g, " ");
  }
}

function localTimezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

/** Format ISO timestamp: primary local, secondary UTC. */
export function formatAutomationTimestamp(iso: string | null | undefined): {
  primary: string;
  secondary: string | null;
} {
  if (!iso) {
    return { primary: "Never", secondary: null };
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { primary: "Unknown", secondary: null };
  }
  const primary = d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const secondary = `${d.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  })} UTC`;
  return { primary, secondary };
}

/** Format UTC hour list for display with local equivalents. */
export function formatUtcHoursForDisplay(hoursUtc: number[]): string {
  if (!hoursUtc.length) return "No run times configured";
  const tz = localTimezoneName();
  return hoursUtc
    .map((h) => {
      const utcLabel = `${String(h).padStart(2, "0")}:00 UTC`;
      const local = new Date(Date.UTC(2026, 0, 15, h, 0, 0)).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
      return `${local} (${tz}) · ${utcLabel}`;
    })
    .join(" · ");
}

/** Format weekly slot (day + hour UTC) with local preview. */
export function formatWeeklySlotDisplay(dayOfWeek: number, hourUtc: number): string {
  const day = WEEKDAY_NAMES[dayOfWeek] ?? "Sunday";
  const utcLabel = `${day}s at ${String(hourUtc).padStart(2, "0")}:00 UTC`;
  const sample = new Date(Date.UTC(2026, 0, 4 + dayOfWeek, hourUtc, 0, 0));
  const local = sample.toLocaleString(undefined, {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${local} (${localTimezoneName()}) · ${utcLabel}`;
}

export type AutomationSavePreview = {
  productUpdate: string;
  removalSync: string;
  historicalBackfill: string;
  reimbursements: string;
  settlement: string;
  financesArchive: string;
};

/** Human-readable save preview from draft store settings. */
export function buildStoreAutomationSavePreview(settings: StoreAutomationSettings): AutomationSavePreview {
  const normalized = normalizeStoreAutomationSettings(settings);
  const legacyPreview = buildAutomationSavePreview({
    product_enrichment: normalized.product_enrichment,
    removal_api_sync: normalized.removal_api_sync,
  });
  const now = new Date();

  const reimbNext = computeApiCardNextRun(normalized.reimbursements_api, now);
  const settNext = computeApiCardNextRun(normalized.settlement_api, now);
  const finNext = computeApiCardNextRun(normalized.finances_archive_api, now);

  return {
    ...legacyPreview,
    reimbursements: cardPreviewLine(
      "Reimbursements API",
      normalized.reimbursements_api.enabled,
      normalized.reimbursements_api.runs_per_day,
      normalized.reimbursements_api.run_hours_utc,
      reimbNext,
    ),
    settlement: cardPreviewLine(
      "Settlement API",
      normalized.settlement_api.enabled,
      normalized.settlement_api.runs_per_day,
      normalized.settlement_api.run_hours_utc,
      settNext,
    ),
    financesArchive: cardPreviewLine(
      "Finances archive API",
      normalized.finances_archive_api.enabled,
      normalized.finances_archive_api.runs_per_day,
      normalized.finances_archive_api.run_hours_utc,
      finNext,
    ),
  };
}

function cardPreviewLine(
  label: string,
  enabled: boolean,
  runsPerDay: number,
  hours: number[],
  next: Date | null,
): string {
  if (!enabled) return `${label} is off — nothing will be scheduled.`;
  const times = formatUtcHoursForDisplay(hours);
  const nextFmt = next ? formatAutomationTimestamp(next.toISOString()) : null;
  return nextFmt
    ? `${label} will run ${runsPerDay} time(s) per day (${times}). Next run: ${nextFmt.primary}.`
    : `${label} is enabled at ${times}.`;
}

/** Human-readable save preview from legacy flat settings. */
export function buildAutomationSavePreview(settings: PlatformAutomationSettings): AutomationSavePreview {
  const normalized = normalizePlatformAutomationSettings(settings);
  const now = new Date();

  const peNext = computeProductEnrichmentNextRun(normalized.product_enrichment, now);
  const peTimes = formatUtcHoursForDisplay(normalized.product_enrichment.run_hours_utc);
  const peNextFmt = peNext ? formatAutomationTimestamp(peNext.toISOString()) : null;

  return {
    productUpdate: !normalized.product_enrichment.enabled
      ? "Product Data Update is off — nothing will be scheduled."
      : peNextFmt
        ? `Product Data Update will run ${normalized.product_enrichment.runs_per_day} time(s) per day (${peTimes}). Next run: ${peNextFmt.primary}${peNextFmt.secondary ? ` (${peNextFmt.secondary})` : ""}.`
        : `Product Data Update is enabled at ${peTimes}.`,
    removalSync: buildRemovalPreview(normalized, now).removalSync,
    historicalBackfill: buildHistoricalPreview(normalized, now),
    reimbursements: cardPreviewLine(
      "Reimbursements API",
      false,
      1,
      [6],
      null,
    ),
    settlement: cardPreviewLine("Settlement API", false, 1, [6], null),
    financesArchive: cardPreviewLine("Finances archive API", false, 1, [6], null),
  };
}

function buildRemovalPreview(settings: PlatformAutomationSettings, now: Date): { removalSync: string } {
  if (!settings.removal_api_sync.enabled) {
    return { removalSync: "Removal / Shipment sync is off — nothing will be scheduled." };
  }
  const next = computeRemovalRecentNextRun(settings.removal_api_sync, now);
  const times = formatUtcHoursForDisplay(settings.removal_api_sync.recent_sync.run_hours_utc);
  const rolling = settings.removal_api_sync.recent_sync.rolling_days;
  const nextFmt = next ? formatAutomationTimestamp(next.toISOString()) : null;
  return {
    removalSync: nextFmt
      ? `Removal sync will run ${settings.removal_api_sync.recent_sync.runs_per_day} time(s) per day (${times}), rolling ${rolling}-day window. Next run: ${nextFmt.primary}. Dry-run only until operator enables apply secrets.`
      : `Removal sync enabled (${times}), ${rolling}-day rolling window. Dry-run only until operator enables apply secrets.`,
  };
}

function buildHistoricalPreview(settings: PlatformAutomationSettings, now: Date): string {
  const hb = settings.removal_api_sync.historical_backfill;
  if (!settings.removal_api_sync.enabled || !hb.enabled) {
    return "Old removal data sync is off — no past windows will be imported.";
  }
  const next = computeRemovalHistoricalNextRun(settings.removal_api_sync, now);
  const slot = formatWeeklySlotDisplay(hb.run_day_of_week, hb.run_hour_utc);
  const windows = hb.window_keys.length ? hb.window_keys.join(", ") : "default window";
  const nextFmt = next ? formatAutomationTimestamp(next.toISOString()) : null;
  return nextFmt
    ? `Old removal data will sync weekly (${slot}), one past window at a time (${windows}). Next run: ${nextFmt.primary}. Runs slowly and separately from daily sync.`
    : `Old removal data sync enabled weekly (${slot}), windows: ${windows}. Runs slowly and separately from daily sync.`;
}

export { WEEKDAY_NAMES };
