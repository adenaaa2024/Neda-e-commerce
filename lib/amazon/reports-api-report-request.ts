/**
 * SP-API Reports request builders (IMPORT-API-09A).
 * Settlement V2 is Amazon-scheduled — list via getReports, not createReport.
 */

import { SP_API_REPORT_TYPE_REIMBURSEMENTS } from "./reports-api-source-run";
import { SP_API_REPORT_TYPE_SETTLEMENT_V2 } from "./reports-api-settlement-plan";

export type OnDemandCreateReportBody = {
  reportType: string;
  marketplaceIds: string[];
  dataStartTime: string;
  dataEndTime: string;
};

export type SettlementListReportsQuery = {
  reportTypes: string;
  marketplaceIds?: string;
  createdSince: string;
  createdUntil: string;
  pageSize: string;
  nextToken?: string;
};

export type ListedReportSummary = {
  reportId: string;
  reportType: string;
  processingStatus: string;
  createdTime: string | null;
  dataStartTime: string | null;
  dataEndTime: string | null;
};

const STATUS_RANK: Record<string, number> = {
  DONE: 0,
  IN_PROGRESS: 1,
  IN_QUEUE: 2,
};

/** Reimbursements and other on-demand report types. */
export function buildOnDemandCreateReportBody(params: {
  reportType: string;
  marketplaceIds: string[];
  dataStartTime: string;
  dataEndTime: string;
}): OnDemandCreateReportBody {
  return {
    reportType: params.reportType.trim(),
    marketplaceIds: params.marketplaceIds.map((s) => s.trim()).filter(Boolean),
    dataStartTime: params.dataStartTime.trim(),
    dataEndTime: params.dataEndTime.trim(),
  };
}

export function buildReimbursementsCreateReportBody(params: {
  marketplaceIds: string[];
  dataStartTime: string;
  dataEndTime: string;
}): OnDemandCreateReportBody {
  return buildOnDemandCreateReportBody({
    reportType: SP_API_REPORT_TYPE_REIMBURSEMENTS,
    ...params,
  });
}

/**
 * Settlement flat file V2 cannot use createReport (Amazon returns HTTP 400).
 * Use getReports with createdSince/createdUntil + reportTypes instead.
 */
export function buildSettlementListReportsQuery(params: {
  marketplaceIds: string[];
  windowStart: string;
  windowEnd: string;
  pageSize?: number;
  nextToken?: string | null;
}): SettlementListReportsQuery {
  const mids = params.marketplaceIds.map((s) => s.trim()).filter(Boolean);
  const q: SettlementListReportsQuery = {
    reportTypes: SP_API_REPORT_TYPE_SETTLEMENT_V2,
    createdSince: params.windowStart.trim(),
    createdUntil: params.windowEnd.trim(),
    pageSize: String(params.pageSize ?? 100),
  };
  if (mids.length) q.marketplaceIds = mids.join(",");
  if (params.nextToken?.trim()) q.nextToken = params.nextToken.trim();
  return q;
}

/** Sanitized JSON for audit logs — no secrets. */
export function sanitizeReportsRequestForAudit(
  value: OnDemandCreateReportBody | SettlementListReportsQuery,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function sanitizeAmazonReportsErrorDetail(detail: string, maxLen = 400): string {
  let s = String(detail ?? "");
  s = s.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt-redacted]");
  s = s.replace(
    /(refresh[_-]?token|client[_-]?secret|access[_-]?key|secret[_-]?access)\s*[:=]\s*["']?[^\s"',}]+/gi,
    "$1=[redacted]",
  );
  s = s.replace(/(Authorization|x-amz-access-token)\s*:\s*\S+/gi, "$1: [redacted]");
  return s.slice(0, maxLen);
}

export function parseListedReportsFromResponse(raw: unknown): ListedReportSummary[] {
  if (!raw || typeof raw !== "object") return [];
  const reports = (raw as { reports?: unknown }).reports;
  if (!Array.isArray(reports)) return [];
  const out: ListedReportSummary[] = [];
  for (const row of reports) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const reportId = typeof r.reportId === "string" ? r.reportId : "";
    const reportType = typeof r.reportType === "string" ? r.reportType : "";
    if (!reportId || !reportType) continue;
    out.push({
      reportId,
      reportType,
      processingStatus: String(r.processingStatus ?? ""),
      createdTime: typeof r.createdTime === "string" ? r.createdTime : null,
      dataStartTime: typeof r.dataStartTime === "string" ? r.dataStartTime : null,
      dataEndTime: typeof r.dataEndTime === "string" ? r.dataEndTime : null,
    });
  }
  return out;
}

/** Prefer DONE settlement reports; newest createdTime first. */
export function pickSettlementReportFromList(
  reports: ListedReportSummary[],
  reportType: string = SP_API_REPORT_TYPE_SETTLEMENT_V2,
): ListedReportSummary | null {
  const matching = reports.filter((r) => r.reportType === reportType);
  if (!matching.length) return null;
  matching.sort((a, b) => {
    const ra = STATUS_RANK[a.processingStatus] ?? 99;
    const rb = STATUS_RANK[b.processingStatus] ?? 99;
    if (ra !== rb) return ra - rb;
    const ta = Date.parse(a.createdTime ?? "") || 0;
    const tb = Date.parse(b.createdTime ?? "") || 0;
    return tb - ta;
  });
  return matching[0] ?? null;
}
