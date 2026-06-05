/** Client-safe automation environment helpers (no Node/server imports). */

export function isAutomationHobbyCronTierClient(): boolean {
  const raw = process.env.NEXT_PUBLIC_AUTOMATION_VERCEL_CRON_TIER?.trim().toLowerCase();
  return raw !== "pro";
}

export function hobbyRemovalScheduleWarning(input: {
  runs_per_day: number;
  run_times_local: string[];
  run_hours_utc: number[];
}): string | null {
  if (!isAutomationHobbyCronTierClient()) return null;
  const localCount = input.run_times_local.length || input.run_hours_utc.length;
  if (input.runs_per_day <= 1 && localCount <= 1) return null;
  return (
    "Vercel Hobby cron can wake at most once per day. Use Runs per day = 1 and one local run time, " +
    "or set NEXT_PUBLIC_AUTOMATION_VERCEL_CRON_TIER=pro (or an external scheduler) for multiple daily runs."
  );
}
