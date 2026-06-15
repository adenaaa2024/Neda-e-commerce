/**
 * Unit tests for reimbursement createReport window clamp (168h Amazon data lag).
 * Run: npm run test:reports-api-reimbursements-window
 */
import { clampReimbursementsCreateWindow, rollingReimbursementsWindow } from "../lib/amazon/reports-api-reimbursements-window";
import { buildReimbursementsCreateReportBody } from "../lib/amazon/reports-api-report-request";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const nowEnd = new Date().toISOString();
const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
const clamped = clampReimbursementsCreateWindow({ start: weekAgo, end: nowEnd });
assert(Date.parse(clamped.end) < Date.parse(nowEnd), "end must be clamped before now");
assert(Date.parse(clamped.start) < Date.parse(clamped.end), "start before end");

const rolling7 = rollingReimbursementsWindow(7);
const spanDays = Math.round((Date.parse(rolling7.end) - Date.parse(rolling7.start)) / 86_400_000);
assert(spanDays >= 6 && spanDays <= 8, `expected ~7d span, got ${spanDays}`);

const body = buildReimbursementsCreateReportBody({
  marketplaceIds: ["ATVPDKIKX0DER"],
  dataStartTime: weekAgo,
  dataEndTime: nowEnd,
});
assert(body.dataEndTime === clamped.end, "create body uses clamped end");
assert(body.dataStartTime === clamped.start, "create body uses clamped start");

console.log("test:reports-api-reimbursements-window OK");
