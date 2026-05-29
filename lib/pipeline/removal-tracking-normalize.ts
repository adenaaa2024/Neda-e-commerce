/**
 * Operational normalization for removal tracking numbers.
 * Preserves raw payloads in raw_row / raw_data; use only for typed operational columns.
 */

export type RemovalTrackingNormalizeStatus =
  | "empty"
  | "single"
  | "deduped_repeated"
  | "multi_conflict";

export type RemovalTrackingNormalizeResult = {
  /** Value safe to persist on operational `tracking_number` when not multi_conflict. */
  operational: string | null;
  status: RemovalTrackingNormalizeStatus;
  /** Trimmed tokens after split (may include duplicates before dedupe). */
  tokens: string[];
  /** Case-sensitive distinct tokens after trim. */
  distinct_tokens: string[];
};

/** Strip wrapping brackets/quotes and whitespace. */
export function stripRemovalTrackingToken(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  // Outer wrappers: [TN], "TN", 'TN'
  for (let i = 0; i < 3; i++) {
    const m = s.match(/^[\[\(\{<"'`]+(.+)[\]\)\}>"'`]+$/);
    if (m && m[1]!.trim()) {
      s = m[1]!.trim();
    } else {
      break;
    }
  }
  return s.replace(/^["']+|["']+$/g, "").trim();
}

/** Split compound tracking strings (comma / semicolon lists). */
export function splitRemovalTrackingList(raw: string): string[] {
  const s = stripRemovalTrackingToken(raw);
  if (!s) return [];
  return s
    .split(/[,;]+/)
    .map((part) => stripRemovalTrackingToken(part))
    .filter(Boolean);
}

/**
 * Normalize a raw tracking field for operational storage.
 * - Repeated identical tokens → single operational value (`deduped_repeated`).
 * - Multiple distinct tokens → `multi_conflict` (operational null; caller must not pick first).
 */
export function normalizeRemovalTrackingOperational(raw: unknown): RemovalTrackingNormalizeResult {
  if (raw === null || raw === undefined) {
    return { operational: null, status: "empty", tokens: [], distinct_tokens: [] };
  }
  const tokens = splitRemovalTrackingList(String(raw));
  if (tokens.length === 0) {
    return { operational: null, status: "empty", tokens: [], distinct_tokens: [] };
  }
  const distinct: string[] = [];
  for (const t of tokens) {
    if (!distinct.includes(t)) distinct.push(t);
  }
  if (distinct.length > 1) {
    return {
      operational: null,
      status: "multi_conflict",
      tokens,
      distinct_tokens: distinct,
    };
  }
  const operational = distinct[0]!;
  const status: RemovalTrackingNormalizeStatus =
    tokens.length > 1 ? "deduped_repeated" : "single";
  return { operational, status, tokens, distinct_tokens: distinct };
}

/** True when operational column likely needs cleanup (comma list or repeated tokens). */
export function isDirtyRemovalTrackingOperational(raw: unknown): boolean {
  const n = normalizeRemovalTrackingOperational(raw);
  return n.status === "deduped_repeated" || n.status === "multi_conflict";
}
