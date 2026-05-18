/**
 * Amazon Selling Partner Reports API v2021-06-30 client (create → poll → document).
 */

import { fetchSpApiJsonWithRetry } from "../pim-amazon-spapi-fetch";
import type { ReportsApiContext } from "./reports-api-credentials";
import {
  buildOnDemandCreateReportBody,
  buildReimbursementsCreateReportBody,
  buildSettlementListReportsQuery,
  parseListedReportsFromResponse,
  sanitizeAmazonReportsErrorDetail,
  type ListedReportSummary,
  type OnDemandCreateReportBody,
  type SettlementListReportsQuery,
} from "./reports-api-report-request";
import { signSpApiRequest } from "./sp-api-aws-sign";
import { SP_API_REPORT_TYPE_REIMBURSEMENTS } from "./reports-api-source-run";

export type SpApiReportProcessingStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "DONE"
  | "FATAL"
  | "CANCELLED"
  | string;

export type CreateReportResult = {
  reportId: string;
  raw: unknown;
};

export type GetReportResult = {
  processingStatus: SpApiReportProcessingStatus;
  reportDocumentId: string | null;
  raw: unknown;
};

export type GetReportDocumentResult = {
  reportDocumentId: string;
  url: string;
  compressionAlgorithm: string | null;
  raw: unknown;
};

export type ReportsApiClientDeps = {
  fetch?: typeof fetch;
  context: ReportsApiContext;
};

function hostFromReportsUrl(reportsHost: string): string {
  return reportsHost.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function signedJsonHeaders(
  ctx: ReportsApiContext,
  method: string,
  path: string,
  body?: string,
  query?: Record<string, string>,
): Record<string, string> {
  const host = hostFromReportsUrl(ctx.reportsHost);
  const signed = signSpApiRequest({
    method,
    host,
    path,
    query,
    body,
    region: ctx.aws.region,
    credentials: {
      accessKeyId: ctx.aws.accessKeyId,
      secretAccessKey: ctx.aws.secretAccessKey,
    },
    headers: {
      "content-type": "application/json",
      "x-amz-access-token": ctx.accessToken,
    },
  });
  return signed;
}

export class ReportsApiClient {
  private readonly fetchFn: typeof fetch;
  private readonly ctx: ReportsApiContext;

  constructor(deps: ReportsApiClientDeps) {
    this.fetchFn = deps.fetch ?? fetch;
    this.ctx = deps.context;
  }

  private url(path: string): string {
    const base = this.ctx.reportsHost.replace(/\/$/, "");
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /** On-demand report types only (e.g. reimbursements). Settlement uses listReports. */
  async createOnDemandReport(body: OnDemandCreateReportBody): Promise<CreateReportResult> {
    const path = "/reports/2021-06-30/reports";
    const payload = JSON.stringify(body);
    const headers = signedJsonHeaders(this.ctx, "POST", path, payload);
    const res = await fetchSpApiJsonWithRetry(this.url(path), {
      method: "POST",
      headers,
      body: payload,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new ReportsApiError("create_report_failed", res.status, res.text.slice(0, 500));
    }
    const json = res.json as Record<string, unknown> | null;
    const reportId = typeof json?.reportId === "string" ? json.reportId : "";
    if (!reportId) throw new ReportsApiError("create_report_missing_id", res.status, res.text.slice(0, 300));
    return { reportId, raw: json };
  }

  async createReport(params: {
    reportType: string;
    marketplaceIds: string[];
    dataStartTime: string;
    dataEndTime: string;
  }): Promise<CreateReportResult> {
    return this.createOnDemandReport(
      buildOnDemandCreateReportBody({
        reportType: params.reportType,
        marketplaceIds: params.marketplaceIds,
        dataStartTime: params.dataStartTime,
        dataEndTime: params.dataEndTime,
      }),
    );
  }

  async createReimbursementsReport(params: {
    marketplaceIds: string[];
    dataStartTime: string;
    dataEndTime: string;
  }): Promise<CreateReportResult> {
    return this.createOnDemandReport(buildReimbursementsCreateReportBody(params));
  }

  /** List Amazon-scheduled settlement reports in a created-time window. */
  async listReports(query: SettlementListReportsQuery): Promise<{
    reports: ListedReportSummary[];
    nextToken: string | null;
    raw: unknown;
  }> {
    const path = "/reports/2021-06-30/reports";
    const headers = signedJsonHeaders(this.ctx, "GET", path, undefined, { ...query });
    const qp = new URLSearchParams(query).toString();
    const url = `${this.url(path)}?${qp}`;
    const res = await fetchSpApiJsonWithRetry(url, {
      method: "GET",
      headers,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new ReportsApiError("list_reports_failed", res.status, res.text.slice(0, 500));
    }
    const json = res.json;
    const nextToken =
      json && typeof json === "object" && typeof (json as { nextToken?: unknown }).nextToken === "string"
        ? (json as { nextToken: string }).nextToken
        : null;
    return {
      reports: parseListedReportsFromResponse(json),
      nextToken,
      raw: json,
    };
  }

  async listSettlementReportsInWindow(params: {
    marketplaceIds: string[];
    windowStart: string;
    windowEnd: string;
    nextToken?: string | null;
  }): Promise<{ reports: ListedReportSummary[]; nextToken: string | null; raw: unknown }> {
    return this.listReports(
      buildSettlementListReportsQuery({
        marketplaceIds: params.marketplaceIds,
        windowStart: params.windowStart,
        windowEnd: params.windowEnd,
        nextToken: params.nextToken,
      }),
    );
  }

  async getReport(reportId: string): Promise<GetReportResult> {
    const path = `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`;
    const headers = signedJsonHeaders(this.ctx, "GET", path);
    const res = await fetchSpApiJsonWithRetry(this.url(path), {
      method: "GET",
      headers,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new ReportsApiError("get_report_failed", res.status, res.text.slice(0, 500));
    }
    const json = res.json as Record<string, unknown> | null;
    const processingStatus = String(json?.processingStatus ?? "");
    const reportDocumentId =
      typeof json?.reportDocumentId === "string" ? json.reportDocumentId : null;
    return { processingStatus, reportDocumentId, raw: json };
  }

  async getReportDocument(reportDocumentId: string): Promise<GetReportDocumentResult> {
    const path = `/reports/2021-06-30/documents/${encodeURIComponent(reportDocumentId)}`;
    const headers = signedJsonHeaders(this.ctx, "GET", path);
    const res = await fetchSpApiJsonWithRetry(this.url(path), {
      method: "GET",
      headers,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new ReportsApiError("get_report_document_failed", res.status, res.text.slice(0, 500));
    }
    const json = res.json as Record<string, unknown> | null;
    const url = typeof json?.url === "string" ? json.url : "";
    if (!url) throw new ReportsApiError("document_missing_url", res.status, res.text.slice(0, 300));
    const compressionAlgorithm =
      typeof json?.compressionAlgorithm === "string" ? json.compressionAlgorithm : null;
    return { reportDocumentId, url, compressionAlgorithm, raw: json };
  }

  /** Document URL is unsigned — separate fetch with retry policy. */
  async downloadReportDocument(url: string): Promise<Buffer> {
    let lastStatus = 0;
    let lastText = "";
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await this.fetchFn(url, { method: "GET", cache: "no-store" });
      lastStatus = res.status;
      if (res.ok) {
        const ab = await res.arrayBuffer();
        return Buffer.from(ab);
      }
      lastText = await res.text().catch(() => "");
      if (res.status !== 429 && res.status !== 503) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
    }
    throw new ReportsApiError("download_failed", lastStatus, lastText.slice(0, 300));
  }
}

export class ReportsApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly detail: string;

  constructor(code: string, httpStatus: number, detail: string) {
    const sanitized = sanitizeAmazonReportsErrorDetail(detail);
    super(`${code} (HTTP ${httpStatus})`);
    this.name = "ReportsApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = sanitized;
  }
}

export function isReportsApiAuthError(err: unknown): boolean {
  if (!(err instanceof ReportsApiError)) return false;
  return err.httpStatus === 401 || err.httpStatus === 403 || err.code === "sp_api_auth_failed";
}

export function isReportsApiThrottleError(err: unknown): boolean {
  return err instanceof ReportsApiError && err.httpStatus === 429;
}
