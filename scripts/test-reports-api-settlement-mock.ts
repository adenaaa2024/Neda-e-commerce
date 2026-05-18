/**
 * Mocked settlement Reports API worker tests — no live Amazon (IMPORT-API-08).
 * Run: npm run test:reports-api-settlement-mock
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isAmazonReportsApiSettlementEnabled,
  isAmazonReportsApiWorkerEnabled,
  reportsApiDisabledReasonForSettlement,
} from "../lib/amazon/reports-api-worker-flags";
import {
  buildReimbursementsIdempotencyKey,
  buildSettlementIdempotencyKey,
} from "../lib/amazon/reports-api-source-run";
import { SP_API_REPORT_TYPE_SETTLEMENT_V2 } from "../lib/amazon/reports-api-settlement-plan";
import {
  buildSettlementListReportsQuery,
  pickSettlementReportFromList,
  parseListedReportsFromResponse,
} from "../lib/amazon/reports-api-report-request";
import { SETTLEMENT_PULL_PROFILE } from "../lib/amazon/reports-api-worker-profile";

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/sp-api-reports/reimbursements");
const SETTLEMENT_FIXTURE_DIR = join(process.cwd(), "tests/fixtures/sp-api-reports/settlement");

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as T;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testFlagsDefaultOff(): void {
  const prevW = process.env.ENABLE_AMAZON_REPORTS_API_WORKER;
  const prevS = process.env.ENABLE_AMAZON_REPORTS_API_SETTLEMENT;
  const prevR = process.env.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS;
  delete process.env.ENABLE_AMAZON_REPORTS_API_WORKER;
  delete process.env.ENABLE_AMAZON_REPORTS_API_SETTLEMENT;
  delete process.env.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS;
  assert(!isAmazonReportsApiWorkerEnabled(), "worker off");
  assert(!isAmazonReportsApiSettlementEnabled(), "settlement off");
  assert(reportsApiDisabledReasonForSettlement() === "worker_disabled", "reason");
  if (prevW !== undefined) process.env.ENABLE_AMAZON_REPORTS_API_WORKER = prevW;
  if (prevS !== undefined) process.env.ENABLE_AMAZON_REPORTS_API_SETTLEMENT = prevS;
  if (prevR !== undefined) process.env.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS = prevR;
}

function testSettlementIdempotencyDistinctFromReimbursements(): void {
  const parts = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    storeId: "00000000-0000-4000-8000-000000000002",
    windowStart: "2026-01-01T00:00:00Z",
    windowEnd: "2026-02-01T00:00:00Z",
    marketplaceIds: ["ATVPDKIKX0DER"],
  };
  const reimb = buildReimbursementsIdempotencyKey(parts);
  const sett = buildSettlementIdempotencyKey(parts);
  assert(reimb !== sett, "settlement and reimbursements keys must differ");
  assert(/^[a-f0-9]{64}$/.test(sett), "sha256 hex");
}

function testSettlementProfile(): void {
  assert(
    SETTLEMENT_PULL_PROFILE.spReportType === SP_API_REPORT_TYPE_SETTLEMENT_V2,
    "sp report type",
  );
  assert(SETTLEMENT_PULL_PROFILE.uploadReportType === "SETTLEMENT", "upload report type");
  assert(SETTLEMENT_PULL_PROFILE.acquisitionMode === "scheduled_list", "scheduled list");
  assert(
    SETTLEMENT_PULL_PROFILE.importDescriptorId === "amazon.settlement.file.v1",
    "descriptor",
  );
  const name = SETTLEMENT_PULL_PROFILE.syntheticFileName("doc-1");
  assert(name.includes("SETTLEMENT"), "synthetic file name");
}

function testSettlementListQuery(): void {
  const q = buildSettlementListReportsQuery({
    marketplaceIds: ["ATVPDKIKX0DER"],
    windowStart: "2026-05-14T00:00:00.000Z",
    windowEnd: "2026-05-17T00:00:00.000Z",
  });
  assert(q.reportTypes === SP_API_REPORT_TYPE_SETTLEMENT_V2, "reportTypes");
  assert(!("dataStartTime" in q), "no createReport dates");
}

class MockSettlementReportsClient {
  async listSettlementReportsInWindow(): Promise<{
    reports: ReturnType<typeof parseListedReportsFromResponse>;
    nextToken: string | null;
    raw: unknown;
  }> {
    const raw = JSON.parse(
      readFileSync(join(SETTLEMENT_FIXTURE_DIR, "list-reports-response.json"), "utf8"),
    ) as unknown;
    return {
      reports: parseListedReportsFromResponse(raw),
      nextToken: null,
      raw,
    };
  }

  async getReport(): Promise<{
    processingStatus: string;
    reportDocumentId: string | null;
    raw: unknown;
  }> {
    const raw = loadJson<{ processingStatus: string; reportDocumentId: string }>(
      "get-report-done.json",
    );
    return {
      processingStatus: raw.processingStatus,
      reportDocumentId: raw.reportDocumentId,
      raw,
    };
  }

  async getReportDocument(): Promise<{
    reportDocumentId: string;
    url: string;
    compressionAlgorithm: string | null;
    raw: unknown;
  }> {
    const raw = loadJson<{ reportDocumentId: string; url: string }>("get-report-document.json");
    return {
      reportDocumentId: raw.reportDocumentId,
      url: raw.url,
      compressionAlgorithm: null,
      raw,
    };
  }

  async downloadReportDocument(): Promise<Buffer> {
    return readFileSync(join(FIXTURE_DIR, "document-body.tsv"));
  }
}

async function testMockClientListSettlement(): Promise<void> {
  const mock = new MockSettlementReportsClient();
  const listed = await mock.listSettlementReportsInWindow({
    marketplaceIds: ["ATVPDKIKX0DER"],
    windowStart: "2026-05-14T00:00:00.000Z",
    windowEnd: "2026-05-17T00:00:00.000Z",
  });
  const picked = pickSettlementReportFromList(listed.reports);
  assert(!!picked?.reportId, "report id from list");
}

async function main(): Promise<void> {
  const tests: { name: string; fn: () => void | Promise<void> }[] = [
    { name: "flags default off", fn: testFlagsDefaultOff },
    { name: "idempotency distinct", fn: testSettlementIdempotencyDistinctFromReimbursements },
    { name: "settlement profile", fn: testSettlementProfile },
    { name: "settlement list query", fn: testSettlementListQuery },
    { name: "mock list settlement", fn: testMockClientListSettlement },
  ];
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok ${t.name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${t.name}:`, e instanceof Error ? e.message : e);
    }
  }
  if (failed > 0) process.exit(1);
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
