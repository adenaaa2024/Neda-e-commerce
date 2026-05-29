/**
 * Operational normalization for removal carrier fields.
 * Preserves raw payloads in raw_row / raw_data; use only for typed operational columns.
 */

export type RemovalCarrierNormalizeStatus =
  | "empty"
  | "single"
  | "deduped_repeated"
  | "multi_conflict";

export type RemovalCarrierNormalizeResult = {
  operational: string | null;
  status: RemovalCarrierNormalizeStatus;
  tokens: string[];
  /** Case-insensitive distinct canonical tokens (first-seen casing kept). */
  distinct_tokens: string[];
};

export { stripRemovalTrackingToken as stripRemovalCarrierToken } from "./removal-tracking-normalize";
import {
  splitRemovalTrackingList,
  stripRemovalTrackingToken,
} from "./removal-tracking-normalize";

/** Split compound carrier strings (comma / semicolon lists). */
export function splitRemovalCarrierList(raw: string): string[] {
  return splitRemovalTrackingList(raw);
}

function distinctCarrierTokens(tokens: string[]): string[] {
  const seen = new Map<string, string>();
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()];
}

/**
 * Normalize a raw carrier field for operational storage.
 * Identical tokens (case-insensitive) → single operational value.
 * Multiple distinct carriers → multi_conflict (operational null).
 */
export function normalizeRemovalCarrierOperational(raw: unknown): RemovalCarrierNormalizeResult {
  if (raw === null || raw === undefined) {
    return { operational: null, status: "empty", tokens: [], distinct_tokens: [] };
  }
  const tokens = splitRemovalCarrierList(String(raw));
  if (tokens.length === 0) {
    return { operational: null, status: "empty", tokens: [], distinct_tokens: [] };
  }
  const distinct = distinctCarrierTokens(tokens);
  if (distinct.length > 1) {
    return {
      operational: null,
      status: "multi_conflict",
      tokens,
      distinct_tokens: distinct,
    };
  }
  const operational = distinct[0]!;
  const status: RemovalCarrierNormalizeStatus =
    tokens.length > 1 ? "deduped_repeated" : "single";
  return { operational, status, tokens, distinct_tokens: distinct };
}

export function isDirtyRemovalCarrierOperational(raw: unknown): boolean {
  const n = normalizeRemovalCarrierOperational(raw);
  return n.status === "deduped_repeated" || n.status === "multi_conflict";
}
