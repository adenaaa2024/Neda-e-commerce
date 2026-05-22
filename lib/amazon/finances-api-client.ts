/**
 * Amazon SP-API Finances v0 client (list groups + list events by group).
 */

import { fetchSpApiJsonWithRetry } from "../pim-amazon-spapi-fetch";
import type { ReportsApiContext } from "./reports-api-credentials";
import { signSpApiRequest } from "./sp-api-aws-sign";

export type FinancesListGroupsResult = {
  financialEventGroupList: Record<string, unknown>[];
  nextToken: string | null;
  raw: unknown;
};

export type FinancesListEventsResult = {
  financialEvents: Record<string, unknown>;
  nextToken: string | null;
  raw: unknown;
};

export type FinancesApiClientDeps = {
  context: ReportsApiContext;
  fetch?: typeof fetch;
};

function hostFromUrl(base: string): string {
  return base.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function signedGet(context: ReportsApiContext, pathWithQuery: string): Record<string, string> {
  const [path, query = ""] = pathWithQuery.split("?");
  return signSpApiRequest({
    method: "GET",
    host: hostFromUrl(context.reportsHost),
    path: path || "/",
    query: query
      ? Object.fromEntries(new URLSearchParams(query))
      : undefined,
    region: context.aws.region,
    credentials: {
      accessKeyId: context.aws.accessKeyId,
      secretAccessKey: context.aws.secretAccessKey,
    },
    headers: {
      "content-type": "application/json",
      "x-amz-access-token": context.accessToken,
    },
  });
}

export class FinancesApiClient {
  private readonly ctx: ReportsApiContext;
  private readonly fetchFn: typeof fetch;

  constructor(deps: FinancesApiClientDeps) {
    this.ctx = deps.context;
    this.fetchFn = deps.fetch ?? fetch;
  }

  private url(pathWithQuery: string): string {
    const base = this.ctx.reportsHost.replace(/\/$/, "");
    return `${base}${pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`}`;
  }

  async listFinancialEventGroups(params: {
    startedAfter: string;
    startedBefore: string;
    nextToken?: string | null;
    maxResultsPerPage?: number;
  }): Promise<FinancesListGroupsResult> {
    const qp = new URLSearchParams();
    qp.set("FinancialEventGroupStartedAfter", params.startedAfter);
    qp.set("FinancialEventGroupStartedBefore", params.startedBefore);
    qp.set("MaxResultsPerPage", String(params.maxResultsPerPage ?? 100));
    if (params.nextToken?.trim()) qp.set("NextToken", params.nextToken.trim());

    const path = `/finances/v0/financialEventGroups?${qp.toString()}`;
    const headers = signedGet(this.ctx, path);
    const res = await fetchSpApiJsonWithRetry(this.url(path), {
      method: "GET",
      headers,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new FinancesApiError("listFinancialEventGroups_failed", res.status, res.text.slice(0, 500));
    }
    const json = (res.json ?? {}) as unknown as Record<string, unknown>;
    const payload = (json.payload ?? json) as unknown as Record<string, unknown>;
    const list = payload.FinancialEventGroupList;
    const groups = Array.isArray(list)
      ? (list.filter((x) => x && typeof x === "object") as unknown as Record<string, unknown>[])
      : [];
    const nextToken =
      typeof payload.NextToken === "string" && payload.NextToken.trim()
        ? payload.NextToken.trim()
        : null;
    return { financialEventGroupList: groups, nextToken, raw: json };
  }

  async listFinancialEventsByGroup(params: {
    eventGroupId: string;
    nextToken?: string | null;
    maxResultsPerPage?: number;
  }): Promise<FinancesListEventsResult> {
    const gid = encodeURIComponent(params.eventGroupId.trim());
    const qp = new URLSearchParams();
    qp.set("MaxResultsPerPage", String(params.maxResultsPerPage ?? 100));
    if (params.nextToken?.trim()) qp.set("NextToken", params.nextToken.trim());

    const path = `/finances/v0/financialEventGroups/${gid}/financialEvents?${qp.toString()}`;
    const headers = signedGet(this.ctx, path);
    const res = await fetchSpApiJsonWithRetry(this.url(path), {
      method: "GET",
      headers,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new FinancesApiError("listFinancialEventsByGroup_failed", res.status, res.text.slice(0, 500));
    }
    const json = (res.json ?? {}) as unknown as Record<string, unknown>;
    const payload = (json.payload ?? json) as unknown as Record<string, unknown>;
    const events =
      payload.FinancialEvents && typeof payload.FinancialEvents === "object"
        ? (payload.FinancialEvents as unknown as Record<string, unknown>)
        : {};
    const nextToken =
      typeof payload.NextToken === "string" && payload.NextToken.trim()
        ? payload.NextToken.trim()
        : null;
    return { financialEvents: events, nextToken, raw: json };
  }
}

export class FinancesApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, detail: string) {
    super(`${code} (HTTP ${httpStatus})`);
    this.name = "FinancesApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isFinancesApiAuthError(err: unknown): boolean {
  return err instanceof FinancesApiError && (err.httpStatus === 401 || err.httpStatus === 403);
}
