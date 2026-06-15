/**
 * Amazon GET_FBA_REIMBURSEMENTS_DATA is only available ~168h after each day closes.
 * Requesting dataEndTime within that lag returns processingStatus=FATAL.
 */

export const REIMBURSEMENTS_DATA_LAG_DAYS = 8;

export type DateWindow = { start: string; end: string };

export function clampReimbursementsCreateWindow(window: DateWindow): DateWindow {
  const endMs = Date.parse(window.end);
  const startMs = Date.parse(window.start);
  if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) {
    throw new Error("Invalid reimbursement window ISO timestamps.");
  }

  const latestEnd = new Date();
  latestEnd.setUTCDate(latestEnd.getUTCDate() - REIMBURSEMENTS_DATA_LAG_DAYS);
  latestEnd.setUTCHours(23, 59, 59, 999);

  let clampedEnd = new Date(endMs);
  if (clampedEnd > latestEnd) clampedEnd = latestEnd;

  let clampedStart = new Date(startMs);
  if (clampedStart >= clampedEnd) {
    clampedStart = new Date(clampedEnd);
    clampedStart.setUTCDate(clampedStart.getUTCDate() - 7);
  }

  return { start: clampedStart.toISOString(), end: clampedEnd.toISOString() };
}

/** Rolling N-day window ending at the latest Amazon-available reimbursement date. */
export function rollingReimbursementsWindow(days: number): DateWindow {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - REIMBURSEMENTS_DATA_LAG_DAYS);
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return clampReimbursementsCreateWindow({ start: start.toISOString(), end: end.toISOString() });
}
