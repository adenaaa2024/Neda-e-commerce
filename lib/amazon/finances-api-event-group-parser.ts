import { FINANCES_API_VERSION_V0, sha256CanonicalJson } from "./finances-api-idempotency";

export type ParsedFinancialEventGroup = {
  event_group_id: string;
  processing_status: string | null;
  fund_transfer_status: string | null;
  original_total: Record<string, unknown> | null;
  converted_total: Record<string, unknown> | null;
  financial_event_group_start: string | null;
  financial_event_group_end: string | null;
  raw_payload: Record<string, unknown>;
  payload_digest: string;
};

function readStr(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function readNullableStr(obj: Record<string, unknown>, ...keys: string[]): string | null {
  const s = readStr(obj, ...keys);
  return s || null;
}

function readMoney(obj: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return null;
  return obj as unknown as Record<string, unknown>;
}

function parseIsoDate(obj: Record<string, unknown>, ...keys: string[]): string | null {
  const s = readNullableStr(obj, ...keys);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

/** Parse one Amazon FinancialEventGroup object (v0 PascalCase). */
export function parseFinancialEventGroupV0(
  group: Record<string, unknown>,
): ParsedFinancialEventGroup | null {
  const event_group_id = readStr(group, "FinancialEventGroupId", "financialEventGroupId");
  if (!event_group_id) return null;

  return {
    event_group_id,
    processing_status: readNullableStr(group, "ProcessingStatus", "processingStatus"),
    fund_transfer_status: readNullableStr(group, "FundTransferStatus", "fundTransferStatus"),
    original_total: readMoney(
      (group.OriginalTotal ?? group.originalTotal) as unknown as Record<string, unknown> | null,
    ),
    converted_total: readMoney(
      (group.ConvertedTotal ?? group.convertedTotal) as unknown as Record<string, unknown> | null,
    ),
    financial_event_group_start: parseIsoDate(
      group,
      "FinancialEventGroupStart",
      "financialEventGroupStart",
    ),
    financial_event_group_end: parseIsoDate(group, "FinancialEventGroupEnd", "financialEventGroupEnd"),
    raw_payload: group,
    payload_digest: sha256CanonicalJson(group),
  };
}

/** Extract groups from a listFinancialEventGroups page raw_body. */
export function extractFinancialEventGroupsFromListPage(
  rawBody: Record<string, unknown>,
): ParsedFinancialEventGroup[] {
  const payload = (rawBody.payload ?? rawBody) as unknown as Record<string, unknown>;
  const list = payload.FinancialEventGroupList ?? payload.financialEventGroupList;
  if (!Array.isArray(list)) return [];
  const out: ParsedFinancialEventGroup[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const parsed = parseFinancialEventGroupV0(item as unknown as Record<string, unknown>);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function dedupeEventGroupsById(
  groups: ParsedFinancialEventGroup[],
): ParsedFinancialEventGroup[] {
  const seen = new Map<string, ParsedFinancialEventGroup>();
  for (const g of groups) {
    const prior = seen.get(g.event_group_id);
    if (!prior || prior.payload_digest !== g.payload_digest) {
      seen.set(g.event_group_id, g);
    }
  }
  return [...seen.values()];
}

export { FINANCES_API_VERSION_V0 };
