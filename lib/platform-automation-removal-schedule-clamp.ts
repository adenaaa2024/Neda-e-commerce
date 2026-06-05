import type { RemovalRecentSyncSchedule } from "./platform-automation-settings-types";

export const HOBBY_REMOVAL_SCHEDULE_DEFAULTS = {
  runs_per_day: 1,
  run_times_local: ["23:30"],
  max_runtime_seconds: 1800,
} as const;

export function applyRemovalScheduleHobbyClamp(
  recent: RemovalRecentSyncSchedule,
  hobbyMode: boolean,
): { recent: RemovalRecentSyncSchedule; warnings: string[] } {
  if (!hobbyMode) return { recent, warnings: [] };

  const warnings: string[] = [];
  let runs_per_day = recent.runs_per_day;
  if (runs_per_day > 1) {
    runs_per_day = 1;
    warnings.push("Runs per day corrected to 1 for Vercel Hobby.");
  }

  let run_times_local = [...recent.run_times_local];
  if (run_times_local.length > 1) {
    run_times_local = run_times_local.slice(0, 1);
    warnings.push("Only one local run time is kept on Vercel Hobby.");
  }
  if (!run_times_local.length) {
    run_times_local = [...HOBBY_REMOVAL_SCHEDULE_DEFAULTS.run_times_local];
  }

  let run_hours_utc = [...recent.run_hours_utc].slice(0, runs_per_day);
  if (!run_hours_utc.length) {
    run_hours_utc = [6];
  }

  const max_runtime_seconds =
    recent.max_runtime_seconds > 0
      ? Math.min(recent.max_runtime_seconds, 3600)
      : HOBBY_REMOVAL_SCHEDULE_DEFAULTS.max_runtime_seconds;

  return {
    recent: {
      ...recent,
      runs_per_day,
      run_times_local,
      run_hours_utc,
      max_runtime_seconds,
    },
    warnings,
  };
}

/** Trim local/UTC slots to explicit runs_per_day (never derive runs_per_day from slot count). */
export function alignRemovalRecentSyncSlots(recent: RemovalRecentSyncSchedule): RemovalRecentSyncSchedule {
  const runs_per_day = Math.max(1, Math.min(24, Math.floor(recent.runs_per_day) || 1));
  return {
    ...recent,
    runs_per_day,
    run_times_local: recent.run_times_local.slice(0, runs_per_day),
    run_hours_utc: recent.run_hours_utc.slice(0, runs_per_day),
  };
}
