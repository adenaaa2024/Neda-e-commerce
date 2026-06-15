/**
 * Amazon getReports enforces ~90-day retention on createdSince/createdUntil.
 * Wider windows return HTTP 400 (list_reports_failed).
 */

export const SETTLEMENT_LIST_REPORTS_MAX_WINDOW_DAYS = 90;

export type DateWindow = { start: string; end: string };

export function settlementListWindowSpanDays(window: DateWindow): number {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.ceil((endMs - startMs) / 86_400_000);
}

/** Clamp an oversized list window to the last N days ending at window.end (Amazon retention law). */
export function clampSettlementListWindow(
  window: DateWindow,
  maxDays: number = SETTLEMENT_LIST_REPORTS_MAX_WINDOW_DAYS,
): DateWindow {
  const span = settlementListWindowSpanDays(window);
  if (span <= maxDays) return { start: window.start.trim(), end: window.end.trim() };
  const end = new Date(window.end);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - maxDays);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Split [start, end) into non-overlapping chunks (default 30d — matches reimbursement backfill). */
export function chunkDateWindow(
  startIso: string,
  endIso: string,
  chunkDays: number = 30,
): DateWindow[] {
  const chunks: DateWindow[] = [];
  let cur = new Date(startIso);
  const end = new Date(endIso);
  while (cur < end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + chunkDays);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ start: cur.toISOString(), end: chunkEnd.toISOString() });
    cur = new Date(chunkEnd);
  }
  return chunks;
}
