/**
 * Settlement createReport / listReports request builders (IMPORT-API-09A).
 * Run: npm run test:reports-api-settlement-create-body
 */

import {
  buildOnDemandCreateReportBody,
  buildReimbursementsCreateReportBody,
  buildSettlementListReportsQuery,
  pickSettlementReportFromList,
  parseListedReportsFromResponse,
  sanitizeAmazonReportsErrorDetail,
  sanitizeReportsRequestForAudit,
} from "../lib/amazon/reports-api-report-request";
import { SP_API_REPORT_TYPE_SETTLEMENT_V2 } from "../lib/amazon/reports-api-settlement-plan";
import { SP_API_REPORT_TYPE_REIMBURSEMENTS } from "../lib/amazon/reports-api-source-run";
import { SETTLEMENT_PULL_PROFILE } from "../lib/amazon/reports-api-worker-profile";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testReimbursementsBodyHasDateRange(): void {
  const body = buildReimbursementsCreateReportBody({
    marketplaceIds: ["ATVPDKIKX0DER"],
    dataStartTime: "2026-05-14T00:00:00.000Z",
    dataEndTime: "2026-05-17T00:00:00.000Z",
  });
  assert(body.reportType === SP_API_REPORT_TYPE_REIMBURSEMENTS, "reimbursements type");
  assert(!!body.dataStartTime && !!body.dataEndTime, "date range");
  const audit = sanitizeReportsRequestForAudit(body);
  assert(audit.dataStartTime === body.dataStartTime, "audit");
}

function testSettlementListQueryNotCreateBody(): void {
  const q = buildSettlementListReportsQuery({
    marketplaceIds: ["ATVPDKIKX0DER"],
    windowStart: "2026-05-14T00:00:00.000Z",
    windowEnd: "2026-05-17T00:00:00.000Z",
  });
  assert(q.reportTypes === SP_API_REPORT_TYPE_SETTLEMENT_V2, "reportTypes");
  assert(q.createdSince === "2026-05-14T00:00:00.000Z", "createdSince");
  assert(q.createdUntil === "2026-05-17T00:00:00.000Z", "createdUntil");
  assert(!("dataStartTime" in q), "no dataStartTime on list query");
  assert(!("dataEndTime" in q), "no dataEndTime on list query");
}

function testSettlementProfileUsesScheduledList(): void {
  assert(SETTLEMENT_PULL_PROFILE.acquisitionMode === "scheduled_list", "acquisition");
  assert(
    SETTLEMENT_PULL_PROFILE.sourceRunOperation === "reports.list_and_download.settlement_v2",
    "operation",
  );
}

function testPickSettlementReport(): void {
  const reports = parseListedReportsFromResponse({
    reports: [
      {
        reportId: "a",
        reportType: SP_API_REPORT_TYPE_SETTLEMENT_V2,
        processingStatus: "IN_PROGRESS",
        createdTime: "2026-05-16T00:00:00Z",
      },
      {
        reportId: "b",
        reportType: SP_API_REPORT_TYPE_SETTLEMENT_V2,
        processingStatus: "DONE",
        createdTime: "2026-05-17T00:00:00Z",
      },
    ],
  });
  const picked = pickSettlementReportFromList(reports);
  assert(picked?.reportId === "b", "prefer DONE");
}

function testSanitizeError(): void {
  const raw =
    'InvalidInput refresh_token=abc123 eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y';
  const s = sanitizeAmazonReportsErrorDetail(raw);
  assert(!s.includes("abc123"), "token redacted");
  assert(!s.includes("eyJ"), "jwt redacted");
}

function testOnDemandBodyExplicit(): void {
  const body = buildOnDemandCreateReportBody({
    reportType: SP_API_REPORT_TYPE_REIMBURSEMENTS,
    marketplaceIds: ["ATVPDKIKX0DER"],
    dataStartTime: "2026-01-01T00:00:00Z",
    dataEndTime: "2026-01-08T00:00:00Z",
  });
  assert(body.reportType === SP_API_REPORT_TYPE_REIMBURSEMENTS, "type");
}

/** Documents the HTTP-400 mistake: settlement must not use createReport date-range body. */
function testSettlementBeforeAfterSanitizedAudit(): void {
  const windowStart = "2026-05-14T00:00:00.000Z";
  const windowEnd = "2026-05-17T00:00:00.000Z";
  const marketplaceIds = ["ATVPDKIKX0DER"];

  const beforeBody = buildOnDemandCreateReportBody({
    reportType: SP_API_REPORT_TYPE_SETTLEMENT_V2,
    marketplaceIds,
    dataStartTime: windowStart,
    dataEndTime: windowEnd,
  });
  const afterQuery = buildSettlementListReportsQuery({
    marketplaceIds,
    windowStart,
    windowEnd,
  });

  const beforeAudit = sanitizeReportsRequestForAudit(beforeBody);
  const afterAudit = sanitizeReportsRequestForAudit(afterQuery);

  assert(beforeAudit.reportType === SP_API_REPORT_TYPE_SETTLEMENT_V2, "before type");
  assert(!!beforeAudit.dataStartTime && !!beforeAudit.dataEndTime, "before has date range");
  assert(afterAudit.reportTypes === SP_API_REPORT_TYPE_SETTLEMENT_V2, "after reportTypes");
  assert(!!afterAudit.createdSince && !!afterAudit.createdUntil, "after created window");
  assert(!("dataStartTime" in afterAudit), "after no createReport start");
  assert(!("dataEndTime" in afterAudit), "after no createReport end");
}

function main(): void {
  const tests = [
    ["reimbursements body", testReimbursementsBodyHasDateRange],
    ["settlement list query", testSettlementListQueryNotCreateBody],
    ["settlement profile", testSettlementProfileUsesScheduledList],
    ["pick settlement", testPickSettlementReport],
    ["sanitize error", testSanitizeError],
    ["on demand body", testOnDemandBodyExplicit],
    ["settlement before/after audit", testSettlementBeforeAfterSanitizedAudit],
  ] as const;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`ok ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}:`, e instanceof Error ? e.message : e);
    }
  }
  if (failed > 0) process.exit(1);
  console.log(`\n${tests.length}/${tests.length} passed`);
}

main();
