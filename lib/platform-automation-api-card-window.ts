/** Rolling calendar window for API card scheduled pulls (UTC, through today). */

export type ApiCardSyncWindow = { start: string; end: string };

export function apiCardSyncWindowThroughToday(rollingDays = 30): ApiCardSyncWindow {
  const days = Math.max(1, Math.min(90, Math.floor(rollingDays)));
  const end = new Date();
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  start.setUTCHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}
