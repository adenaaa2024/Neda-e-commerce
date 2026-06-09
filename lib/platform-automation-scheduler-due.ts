import {
  computeNextDailyRunUtc,
  computeNextWeeklyRunUtc,
  computeRemovalHistoricalNextRun,
  computeRemovalRecentNextRun,
} from "./platform-automation-schedule";
import type {
  ApiAutomationCardSchedule,
  FinancesArchiveApiSchedule,
  PlatformAutomationSettings,
  ProductEnrichmentSchedule,
  RemovalApiSyncSchedule,
  StoreAutomationSettings,
} from "./platform-automation-settings-types";

export type ScheduleDueResult = {
  enabled: boolean;
  due: boolean;
  reason: string;
  current_hour_utc: number;
  run_hours_utc: number[];
  next_run_at: string | null;
};

export type RemovalScheduleEvaluation = {
  settings_source: "platform_settings.automation_settings.removal_api_sync";
  enabled: boolean;
  rolling_days: number;
  recent: ScheduleDueResult;
  historical: ScheduleDueResult & {
    window_keys: string[];
    auto_apply: false;
    run_day_of_week: number;
    run_hour_utc: number;
  };
};

export type ProductEnrichmentScheduleEvaluation = {
  settings_source: "platform_settings.automation_settings.product_enrichment";
  schedule: ScheduleDueResult;
};

function currentHourUtc(now: Date): number {
  return now.getUTCHours();
}

/** Daily slot is due when enabled and current UTC hour is in configured run_hours_utc. */
export function evaluateDailyScheduleDue(
  enabled: boolean,
  runHoursUtc: number[],
  now: Date = new Date(),
): ScheduleDueResult {
  const hour = currentHourUtc(now);
  const hours = [...new Set(runHoursUtc.map((h) => Math.floor(h) % 24))].sort((a, b) => a - b);
  if (!enabled) {
    return {
      enabled: false,
      due: false,
      reason: "schedule_disabled",
      current_hour_utc: hour,
      run_hours_utc: hours,
      next_run_at: null,
    };
  }
  const due = hours.includes(hour);
  return {
    enabled: true,
    due,
    reason: due ? "hour_match" : "not_due_this_hour",
    current_hour_utc: hour,
    run_hours_utc: hours,
    next_run_at: computeNextDailyRunUtc(true, hours, now)?.toISOString() ?? null,
  };
}

export function evaluateProductEnrichmentSchedule(
  schedule: ProductEnrichmentSchedule,
  now: Date = new Date(),
): ProductEnrichmentScheduleEvaluation {
  return {
    settings_source: "platform_settings.automation_settings.product_enrichment",
    schedule: evaluateDailyScheduleDue(schedule.enabled, schedule.run_hours_utc, now),
  };
}

export function evaluateRemovalAutomationSchedule(
  schedule: RemovalApiSyncSchedule,
  now: Date = new Date(),
): RemovalScheduleEvaluation {
  const recent = evaluateDailyScheduleDue(
    schedule.enabled,
    schedule.recent_sync.run_hours_utc,
    now,
  );
  const hb = schedule.historical_backfill;
  const histEnabled = schedule.enabled && hb.enabled;
  const hour = currentHourUtc(now);
  const dow = now.getUTCDay();
  const histDue =
    histEnabled && dow === hb.run_day_of_week && hour === hb.run_hour_utc;
  return {
    settings_source: "platform_settings.automation_settings.removal_api_sync",
    enabled: schedule.enabled,
    rolling_days: schedule.recent_sync.rolling_days,
    recent,
    historical: {
      enabled: histEnabled,
      due: histDue,
      reason: !schedule.enabled
        ? "removal_sync_disabled"
        : !hb.enabled
          ? "historical_disabled"
          : histDue
            ? "weekly_slot_match"
            : "not_due_this_weekly_slot",
      current_hour_utc: hour,
      run_hours_utc: [hb.run_hour_utc],
      next_run_at: computeRemovalHistoricalNextRun(schedule, now)?.toISOString() ?? null,
      window_keys: hb.window_keys,
      auto_apply: false,
      run_day_of_week: hb.run_day_of_week,
      run_hour_utc: hb.run_hour_utc,
    },
  };
}

export type ApiCardScheduleEvaluation = {
  settings_source:
    | "platform_settings.automation_settings.reimbursements_api"
    | "platform_settings.automation_settings.settlement_api"
    | "platform_settings.automation_settings.finances_archive_api";
  card: "reimbursements_api" | "settlement_api" | "finances_archive_api";
  enabled: boolean;
  rolling_days: number;
  schedule: ScheduleDueResult;
};

export function evaluateApiCardSchedule(
  card: ApiCardScheduleEvaluation["card"],
  schedule: ApiAutomationCardSchedule | FinancesArchiveApiSchedule,
  now: Date = new Date(),
): ApiCardScheduleEvaluation {
  const settings_source =
    card === "reimbursements_api"
      ? "platform_settings.automation_settings.reimbursements_api"
      : card === "settlement_api"
        ? "platform_settings.automation_settings.settlement_api"
        : "platform_settings.automation_settings.finances_archive_api";
  return {
    settings_source,
    card,
    enabled: schedule.enabled,
    rolling_days: schedule.rolling_days,
    schedule: evaluateDailyScheduleDue(schedule.enabled, schedule.run_hours_utc, now),
  };
}

export function evaluateAllApiCardSchedules(
  settings: Pick<
    StoreAutomationSettings,
    "reimbursements_api" | "settlement_api" | "finances_archive_api"
  >,
  now: Date = new Date(),
): {
  reimbursements_api: ApiCardScheduleEvaluation;
  settlement_api: ApiCardScheduleEvaluation;
  finances_archive_api: ApiCardScheduleEvaluation;
} {
  return {
    reimbursements_api: evaluateApiCardSchedule("reimbursements_api", settings.reimbursements_api, now),
    settlement_api: evaluateApiCardSchedule("settlement_api", settings.settlement_api, now),
    finances_archive_api: evaluateApiCardSchedule(
      "finances_archive_api",
      settings.finances_archive_api,
      now,
    ),
  };
}

export type SchedulerTickAction = "noop" | "dry_run_log" | "apply";

export function resolveSchedulerAction(input: {
  due: boolean;
  enabled: boolean;
  applyRequested: boolean;
  confirmApply: boolean;
}): { action: SchedulerTickAction; reason: string } {
  if (!input.enabled) return { action: "noop", reason: "disabled" };
  if (!input.due) return { action: "noop", reason: "not_due" };
  if (input.applyRequested && input.confirmApply) {
    return { action: "apply", reason: "due_with_apply_gate" };
  }
  return { action: "dry_run_log", reason: "due_dry_run_only" };
}

export function summarizeAutomationSettings(settings: PlatformAutomationSettings): {
  product_enrichment: ProductEnrichmentScheduleEvaluation;
  removal_api_sync: RemovalScheduleEvaluation;
} {
  const now = new Date();
  return {
    product_enrichment: evaluateProductEnrichmentSchedule(settings.product_enrichment, now),
    removal_api_sync: evaluateRemovalAutomationSchedule(settings.removal_api_sync, now),
  };
}

export function computeRemovalRecentNextRunIso(
  schedule: RemovalApiSyncSchedule,
  now: Date = new Date(),
): string | null {
  return computeRemovalRecentNextRun(schedule, now)?.toISOString() ?? null;
}

export function computeNextWeeklyRunIso(
  enabled: boolean,
  dayOfWeek: number,
  hourUtc: number,
  now: Date = new Date(),
): string | null {
  return computeNextWeeklyRunUtc(enabled, dayOfWeek, hourUtc, now)?.toISOString() ?? null;
}
