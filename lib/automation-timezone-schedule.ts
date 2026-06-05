/** IANA timezone helpers for platform automation (no external deps). */

export const REMOVAL_CRON_WAKE_GRACE_MS = 15 * 60 * 1000;

export type LocalTimeParts = { hour: number; minute: number };

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export function isValidIanaTimeZone(tz: string): boolean {
  const s = tz.trim();
  if (!s) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: s });
    return true;
  } catch {
    return false;
  }
}

export function parseLocalRunTime(raw: string): LocalTimeParts | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function parseLocalRunTimes(raw: unknown, fallbackFromUtcHours: number[]): string[] {
  if (Array.isArray(raw)) {
    const parsed = raw
      .filter((x): x is string => typeof x === "string")
      .map((x) => parseLocalRunTime(x))
      .filter((x): x is LocalTimeParts => x != null)
      .map((p) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`);
    if (parsed.length) return [...new Set(parsed)].sort();
  }
  return fallbackFromUtcHours.map((h) => `${String(h).padStart(2, "0")}:00`);
}

export function partsInTimeZone(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}

/** Map local calendar date+time in IANA zone to UTC instant. */
export function utcInstantFromLocalParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let lo = Date.UTC(year, month - 1, day, hour - 14, minute, 0, 0);
  let hi = Date.UTC(year, month - 1, day, hour + 14, minute, 0, 0);
  for (let i = 0; i < 48; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const p = partsInTimeZone(new Date(mid), timeZone);
    const cmp =
      p.year !== year
        ? p.year - year
        : p.month !== month
          ? p.month - month
          : p.day !== day
            ? p.day - day
            : p.hour !== hour
              ? p.hour - hour
              : p.minute - minute;
    if (cmp === 0) return new Date(mid);
    if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

export function slotKeyLocal(
  year: number,
  month: number,
  day: number,
  runTime: string,
  timeZone: string,
): string {
  return `${timeZone}|${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}|${runTime}`;
}

export function evaluateLocalDailyScheduleDue(input: {
  enabled: boolean;
  timeZone: string;
  runTimesLocal: string[];
  lastRunAt: string | null;
  lastSlotKey: string | null;
  now?: Date;
  graceMs?: number;
}): {
  due: boolean;
  reason: string;
  next_run_at: string | null;
  matched_slot_key: string | null;
  matched_slot_at: string | null;
} {
  const now = input.now ?? new Date();
  const graceMs = input.graceMs ?? REMOVAL_CRON_WAKE_GRACE_MS;
  if (!input.enabled) {
    return {
      due: false,
      reason: "schedule_disabled",
      next_run_at: null,
      matched_slot_key: null,
      matched_slot_at: null,
    };
  }
  const times = input.runTimesLocal
    .map((t) => parseLocalRunTime(t))
    .filter((t): t is LocalTimeParts => t != null);
  if (!times.length) {
    return {
      due: false,
      reason: "no_run_times",
      next_run_at: null,
      matched_slot_key: null,
      matched_slot_at: null,
    };
  }

  const zonedNow = partsInTimeZone(now, input.timeZone);
  const dayOffsets = [-1, 0];
  let matchedSlotKey: string | null = null;
  let matchedSlotAt: Date | null = null;

  for (const dayOffset of dayOffsets) {
    const base = utcInstantFromLocalParts(
      zonedNow.year,
      zonedNow.month,
      zonedNow.day,
      12,
      0,
      input.timeZone,
    );
    base.setUTCDate(base.getUTCDate() + dayOffset);
    const zp = partsInTimeZone(base, input.timeZone);
    for (const rt of times) {
      const runTimeStr = `${String(rt.hour).padStart(2, "0")}:${String(rt.minute).padStart(2, "0")}`;
      const slotUtc = utcInstantFromLocalParts(zp.year, zp.month, zp.day, rt.hour, rt.minute, input.timeZone);
      const slotEnd = slotUtc.getTime() + graceMs;
      const nowMs = now.getTime();
      if (nowMs < slotUtc.getTime() || nowMs >= slotEnd) continue;
      const key = slotKeyLocal(zp.year, zp.month, zp.day, runTimeStr, input.timeZone);
      const lastRunMs = input.lastRunAt ? Date.parse(input.lastRunAt) : NaN;
      if (input.lastSlotKey === key || (Number.isFinite(lastRunMs) && lastRunMs >= slotUtc.getTime())) {
        continue;
      }
      matchedSlotKey = key;
      matchedSlotAt = slotUtc;
      break;
    }
    if (matchedSlotAt) break;
  }

  const next = computeNextLocalDailyRunUtc(input.timeZone, input.runTimesLocal, now);
  if (matchedSlotAt) {
    return {
      due: true,
      reason: "local_slot_in_wake_window",
      next_run_at: next?.toISOString() ?? null,
      matched_slot_key: matchedSlotKey,
      matched_slot_at: matchedSlotAt.toISOString(),
    };
  }

  return {
    due: false,
    reason: "not_scheduled",
    next_run_at: next?.toISOString() ?? null,
    matched_slot_key: null,
    matched_slot_at: null,
  };
}

export function computeNextLocalDailyRunUtc(
  timeZone: string,
  runTimesLocal: string[],
  now: Date = new Date(),
): Date | null {
  const times = runTimesLocal
    .map((t) => parseLocalRunTime(t))
    .filter((t): t is LocalTimeParts => t != null)
    .sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  if (!times.length) return null;

  const tz = isValidIanaTimeZone(timeZone) ? timeZone : "UTC";
  const zonedNow = partsInTimeZone(now, tz);
  const candidates: Date[] = [];
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    const base = utcInstantFromLocalParts(zonedNow.year, zonedNow.month, zonedNow.day, 12, 0, tz);
    base.setUTCDate(base.getUTCDate() + dayOffset);
    const zp = partsInTimeZone(base, tz);
    for (const rt of times) {
      const slot = utcInstantFromLocalParts(zp.year, zp.month, zp.day, rt.hour, rt.minute, tz);
      if (slot.getTime() > now.getTime()) candidates.push(slot);
    }
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] ?? null;
}

function inputTimeZoneSafe(tz: string): string {
  return isValidIanaTimeZone(tz) ? tz : "UTC";
}

export function formatLocalRunTimesForInput(times: string[] | null | undefined): string {
  return (times ?? []).join(", ");
}

export function parseLocalRunTimesFromInput(text: string, maxCount: number): string[] {
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const parsed = parseLocalRunTime(p);
    if (!parsed) continue;
    out.push(`${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`);
  }
  const unique = [...new Set(out)].sort();
  return unique.slice(0, Math.max(1, maxCount));
}
