import type { ClaimCenterV1Row } from "./claim-center-v1-types";

const TWIN_SOURCE_KINDS = new Set(["scanner_physical_review", "orbit_fra"]);

export type ClaimCenterTwinGroup = {
  group_key: string;
  primary: ClaimCenterV1Row;
  twin_source_kinds: string[];
  twin_candidate_ids: string[];
  is_grouped: boolean;
};

const SOURCE_PRIORITY: Record<string, number> = {
  orbit_fra: 0,
  scanner_physical_review: 1,
};

function physicalGroupKey(row: ClaimCenterV1Row): string | null {
  if (row.source_table !== "return_items") return null;
  if (!TWIN_SOURCE_KINDS.has(row.source_kind ?? "")) return null;
  return `${row.source_table}:${row.source_row_id}`;
}

function pickPrimary(rows: ClaimCenterV1Row[]): ClaimCenterV1Row {
  return [...rows].sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.source_kind ?? ""] ?? 9;
    const pb = SOURCE_PRIORITY[b.source_kind ?? ""] ?? 9;
    return pa - pb;
  })[0]!;
}

/** Display-only grouping for scanner/ORBIT twins sharing the same physical return_item. */
export function groupTwinCandidatesForDisplay(rows: ClaimCenterV1Row[]): ClaimCenterTwinGroup[] {
  const singles: ClaimCenterTwinGroup[] = [];
  const twinBuckets = new Map<string, ClaimCenterV1Row[]>();

  for (const row of rows) {
    const key = physicalGroupKey(row);
    if (!key) {
      singles.push({
        group_key: row.id,
        primary: row,
        twin_source_kinds: row.source_kind ? [row.source_kind] : [],
        twin_candidate_ids: [row.id],
        is_grouped: false,
      });
      continue;
    }
    const list = twinBuckets.get(key) ?? [];
    list.push(row);
    twinBuckets.set(key, list);
  }

  for (const [key, bucket] of twinBuckets) {
    const primary = pickPrimary(bucket);
    const kinds = [...new Set(bucket.map((r) => r.source_kind).filter(Boolean))] as string[];
    singles.push({
      group_key: key,
      primary: {
        ...primary,
        twin_group_key: key,
        twin_source_kinds: kinds,
        twin_candidate_ids: bucket.map((r) => r.id),
        is_twin_primary: true,
      },
      twin_source_kinds: kinds,
      twin_candidate_ids: bucket.map((r) => r.id),
      is_grouped: kinds.length > 1,
    });
  }

  return singles;
}

export function flattenTwinGroups(groups: ClaimCenterTwinGroup[]): ClaimCenterV1Row[] {
  return groups.map((g) => g.primary);
}

/** Attach twin metadata to every row sharing the same physical return_item (read-only enrichment). */
export function attachTwinMetadataToRows(rows: ClaimCenterV1Row[]): ClaimCenterV1Row[] {
  const buckets = new Map<string, ClaimCenterV1Row[]>();
  for (const row of rows) {
    const key = physicalGroupKey(row);
    if (!key) continue;
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }

  return rows.map((row) => {
    const key = physicalGroupKey(row);
    if (!key) return row;
    const bucket = buckets.get(key) ?? [row];
    const kinds = [...new Set(bucket.map((r) => r.source_kind).filter(Boolean))] as string[];
    const primary = pickPrimary(bucket);
    return {
      ...row,
      twin_group_key: key,
      twin_source_kinds: kinds,
      twin_candidate_ids: bucket.map((r) => r.id),
      is_twin_primary: primary.id === row.id,
    };
  });
}

export function twinSourceChipLabel(kind: string): string {
  if (kind === "scanner_physical_review") return "Scanner signal";
  if (kind === "orbit_fra") return "ORBIT/FRA signal";
  return kind.replace(/_/g, " ");
}
