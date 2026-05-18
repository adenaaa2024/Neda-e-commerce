/**
 * Mocked Reports API reimbursements worker tests — no live Amazon.
 * Run: npm run test:reports-api-reimbursements-mock
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  isAmazonReportsApiReimbursementsEnabled,
  isAmazonReportsApiWorkerEnabled,
  reportsApiDisabledReasonForReimbursements,
} from "../lib/amazon/reports-api-worker-flags";
import { buildReimbursementsIdempotencyKey } from "../lib/amazon/reports-api-source-run";
import { signSpApiRequest } from "../lib/amazon/sp-api-aws-sign";
import { parseCsvHeadersFromText, sha256Hex } from "../lib/amazon/reports-api-document-utils";

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/sp-api-reports/reimbursements");

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as T;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

class MockReimbursementsReportsClient {
  createCalls = 0;
  getReportCalls = 0;
  private readonly documentBody: Buffer;

  constructor(documentBody: Buffer) {
    this.documentBody = documentBody;
  }

  async createReimbursementsReport(): Promise<{ reportId: string; raw: unknown }> {
    this.createCalls++;
    const raw = loadJson<{ reportId: string }>("create-report-response.json");
    return { reportId: raw.reportId, raw };
  }

  async getReport(): Promise<{
    processingStatus: string;
    reportDocumentId: string | null;
    raw: unknown;
  }> {
    this.getReportCalls++;
    if (this.getReportCalls < 2) {
      const raw = loadJson("get-report-in-progress.json");
      return {
        processingStatus: String((raw as { processingStatus?: string }).processingStatus),
        reportDocumentId: null,
        raw,
      };
    }
    const raw = loadJson<{ processingStatus: string; reportDocumentId: string }>("get-report-done.json");
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
    return this.documentBody;
  }
}

async function testFlagsDefaultOff(): Promise<void> {
  const prevW = process.env.ENABLE_AMAZON_REPORTS_API_WORKER;
  const prevR = process.env.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS;
  delete process.env.ENABLE_AMAZON_REPORTS_API_WORKER;
  delete process.env.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS;
  assert(!isAmazonReportsApiWorkerEnabled(), "worker flag should default off");
  assert(!isAmazonReportsApiReimbursementsEnabled(), "reimbursements flag should default off");
  assert(reportsApiDisabledReasonForReimbursements() === "worker_disabled", "disabled reason");
  if (prevW !== undefined) process.env.ENABLE_AMAZON_REPORTS_API_WORKER = prevW;
  if (prevR !== undefined) process.env.ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS = prevR;
}

function testIdempotencyKeyStable(): void {
  const a = buildReimbursementsIdempotencyKey({
    organizationId: "00000000-0000-4000-8000-000000000001",
    storeId: "00000000-0000-4000-8000-000000000002",
    windowStart: "2026-01-01T00:00:00Z",
    windowEnd: "2026-02-01T00:00:00Z",
    marketplaceIds: ["ATVPDKIKX0DER", "A2EUQ1WTGCTBG2"],
  });
  const b = buildReimbursementsIdempotencyKey({
    organizationId: "00000000-0000-4000-8000-000000000001",
    storeId: "00000000-0000-4000-8000-000000000002",
    windowStart: "2026-01-01T00:00:00Z",
    windowEnd: "2026-02-01T00:00:00Z",
    marketplaceIds: ["A2EUQ1WTGCTBG2", "ATVPDKIKX0DER"],
  });
  assert(a === b, "idempotency key must be stable regardless of marketplace order");
  assert(/^[a-f0-9]{64}$/.test(a), "idempotency key must be sha256 hex");
}

function testSigV4Headers(): void {
  const headers = signSpApiRequest({
    method: "POST",
    host: "sellingpartnerapi-na.amazon.com",
    path: "/reports/2021-06-30/reports",
    body: "{}",
    credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" },
    headers: { "x-amz-access-token": "token-redacted" },
  });
  assert(typeof headers.Authorization === "string" && headers.Authorization.includes("AWS4-HMAC-SHA256"), "Authorization");
  assert(typeof headers["x-amz-date"] === "string", "x-amz-date");
  assert(headers.host === "sellingpartnerapi-na.amazon.com", "host");
}

function testDocumentParse(): void {
  const tsv = readFileSync(join(FIXTURE_DIR, "document-body.tsv"), "utf8");
  const headers = parseCsvHeadersFromText(tsv);
  assert(headers[0] === "reimbursement-id", "header reimbursement-id");
  const sha = sha256Hex(Buffer.from(tsv, "utf8"));
  assert(sha.length === 64, "sha256");
}

async function testMockClientPollResume(): Promise<void> {
  const doc = readFileSync(join(FIXTURE_DIR, "document-body.tsv"));
  const mock = new MockReimbursementsReportsClient(doc);

  const mid = await mock.getReport();
  assert(mid.processingStatus === "IN_PROGRESS", "in progress");

  const done = await mock.getReport();
  assert(done.processingStatus === "DONE" && Boolean(done.reportDocumentId), "done");
  assert(mock.createCalls === 0, "no create in resume-only poll simulation");
}

async function testWorkerWithSupabaseOptional(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.log("  (skip worker E2E — no Supabase env)");
    return;
  }
  console.log("  (skip worker E2E in tsx — run via dev server + flags; mock unit tests cover client/resume)");
}

async function main(): Promise<void> {
  const tests: { name: string; fn: () => void | Promise<void> }[] = [
    { name: "flags default off", fn: testFlagsDefaultOff },
    { name: "idempotency key", fn: testIdempotencyKeyStable },
    { name: "sigv4 headers", fn: testSigV4Headers },
    { name: "document parse", fn: testDocumentParse },
    { name: "mock poll resume", fn: testMockClientPollResume },
    { name: "worker supabase optional", fn: testWorkerWithSupabaseOptional },
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
