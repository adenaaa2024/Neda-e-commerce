/**
 * NEXT-18M — Pure helpers for the offline identifier-dispute classifier.
 *
 * No Supabase imports. No filesystem side effects. No AI calls. Every function
 * is deterministic: same NEXT-18K disk snapshot ⇒ identical taxonomy cells,
 * dispute ids, authority decisions, and conflict JSON.
 *
 * Exposed surface (consumed by scripts/product-seed-dispute-classifier.ts):
 *   - constants (KIND_AUTHORITY_LEVEL, ON_CONFLICT_DEFAULT, CELL_PRIORITY_ORDER)
 *   - dispute id derivation (deriveDisputeIdA / deriveDisputeIdB)
 *   - C6 leading-zero / mfg-part normalization detector
 *   - taxonomy classifier (assignShardATaxonomy / assignShardBTaxonomy)
 *   - authority matrix application (applyAuthorityMatrix)
 *   - identifier_conflicts JSON builder
 *   - hot_loser_flag + reversibility window resolver
 *   - AI advisory placeholder builder
 *   - secondary-cell aggregator
 *
 * Reference: [c:\Users\Jennifer\.cursor\plans\conflict_resolution_architecture_b551fe3b.plan.md]
 *            [c:\Users\Jennifer\.cursor\plans\dispute_classifier_dryrun_dda6cb2b.plan.md]
 */

import { createHash } from "node:crypto";

// ── Constants ───────────────────────────────────────────────────────────────

export type IdentifierKindBroad =
  | "asin"
  | "fnsku"
  | "sku"
  | "upc_code"
  | "mfg_part_number"
  | "gtin"
  | "ean"
  | "isbn"
  | "barcode"
  | "upc"; // NEXT-18K emits `upc` in identifier-authority CSVs; aliased to upc_code in policy

export type AuthorityLevel = "strong" | "medium" | "weak";

/** Per NEXT-18L section A. `upc` is normalized to `upc_code` semantically. */
export const KIND_AUTHORITY_LEVEL: Readonly<Record<IdentifierKindBroad, AuthorityLevel>> = {
  asin: "strong",
  fnsku: "strong",
  sku: "strong",
  upc_code: "medium",
  upc: "medium",
  mfg_part_number: "weak",
  gtin: "weak",
  ean: "weak",
  isbn: "weak",
  barcode: "weak",
};

export type OnConflictPolicy = "escalate" | "drop_kind_from_winner" | "prefer_most_recently_seen";

export const ON_CONFLICT_DEFAULT: Readonly<Record<AuthorityLevel, OnConflictPolicy>> = {
  strong: "escalate",
  medium: "drop_kind_from_winner",
  weak: "drop_kind_from_winner",
};

export type TaxonomyCell = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8";

/** Plan section D. Lower index = higher priority. */
export const CELL_PRIORITY_ORDER: readonly TaxonomyCell[] = ["C1", "C2", "C4", "C5", "C3", "C6", "C7", "C8"];

export function cellRank(cell: TaxonomyCell): number {
  return CELL_PRIORITY_ORDER.indexOf(cell);
}

/** Aliasing layer: NEXT-18K uses `upc`; policy/schema use `upc_code`. */
export function canonicalizeKind(kind: string): IdentifierKindBroad {
  const k = kind.trim().toLowerCase();
  if (k === "upc") return "upc_code";
  if (k in KIND_AUTHORITY_LEVEL) return k as IdentifierKindBroad;
  return k as IdentifierKindBroad;
}

export const STRONG_KINDS: ReadonlySet<IdentifierKindBroad> = new Set(["asin", "fnsku", "sku"]);
export const WEAK_KINDS_FOR_C6: ReadonlySet<IdentifierKindBroad> = new Set([
  "upc_code",
  "gtin",
  "ean",
  "isbn",
  "barcode",
  "mfg_part_number",
]);

// ── Dispute id derivation ───────────────────────────────────────────────────

function sha256_32(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}

export function deriveDisputeIdA(args: {
  organizationId: string;
  storeId: string | null;
  members: readonly string[];
}): string {
  const sorted = [...args.members].sort();
  return sha256_32(`A|${args.organizationId}|${args.storeId ?? ""}|${sorted.join("|")}`);
}

export function deriveDisputeIdB(args: {
  organizationId: string;
  storeId: string | null;
  orphanId: string;
  externalCandidates: readonly string[];
}): string {
  const sorted = [...args.externalCandidates].sort();
  return sha256_32(
    `B|${args.organizationId}|${args.storeId ?? ""}|${args.orphanId}|${sorted.join(",")}`,
  );
}

// ── C6 detection ────────────────────────────────────────────────────────────

function stripLeadingZeros(s: string): string {
  return s.replace(/^0+/, "") || "0";
}

function collapseMfgPart(s: string): string {
  return s.replace(/\s+/g, "").toUpperCase();
}

/**
 * Returns true if any pair of `values` reduces to an equal canonical form after
 * applying the kind-appropriate normalization (leading-zero strip for digit
 * kinds, whitespace+case collapse for mfg_part_number). Single-value lists are
 * always `false` (no pair to compare).
 */
export function detectC6(kind: IdentifierKindBroad, values: readonly string[]): boolean {
  if (values.length < 2) return false;
  if (!WEAK_KINDS_FOR_C6.has(kind)) return false;
  const fold =
    kind === "mfg_part_number"
      ? collapseMfgPart
      : (s: string): string => stripLeadingZeros(s);
  const seen = new Set<string>();
  for (const v of values) {
    const c = fold(v);
    if (seen.has(c)) return true;
    seen.add(c);
  }
  return false;
}

// ── Conflict-row shapes (NEXT-18K 05-shardA-identifier-authority.csv) ───────

export type AuthorityCsvRow = {
  group_id: string;
  kind: string;
  result: "adopted" | "conflict";
  winner_value: string;
  contributing_members: string[];
  conflict_values: string[];
  conflict_members: string[];
};

export type ShardAGroupInputs = {
  group_id: string;
  organization_id: string;
  store_id: string | null;
  members: string[];
  winner_id: string;
  block_reasons: string[];
  cluster_overlap_count: number;
  mismatch_overlap_count: number;
  any_hot_loser: boolean;
  identifier_authority_rows: AuthorityCsvRow[];
};

export type CrossGroupStrongIdIndex = Map<string, Set<string>>;

/**
 * Build an index of (kind|value) -> set<group_id> across the entire Shard A
 * authority-CSV corpus. Both `adopted` winner_values and `conflict_values` are
 * registered. Used by C2 detection: any kind|value pair shared by 2+ groups is
 * cross-group strong-id reuse evidence.
 */
export function buildCrossGroupStrongIdIndex(
  rows: readonly AuthorityCsvRow[],
): CrossGroupStrongIdIndex {
  const idx = new Map<string, Set<string>>();
  for (const r of rows) {
    const kind = canonicalizeKind(r.kind);
    if (!STRONG_KINDS.has(kind)) continue;
    const values: string[] = [];
    if (r.result === "adopted" && r.winner_value) values.push(r.winner_value);
    if (r.result === "conflict") for (const v of r.conflict_values) if (v) values.push(v);
    for (const v of values) {
      const key = `${kind}|${v}`;
      const s = idx.get(key);
      if (s) s.add(r.group_id);
      else idx.set(key, new Set([r.group_id]));
    }
  }
  return idx;
}

// ── Taxonomy: Shard A ───────────────────────────────────────────────────────

export type IdentifierConflictEntry = {
  kind: IdentifierKindBroad;
  values: string[];
  members: string[];
  authority_level: AuthorityLevel;
  policy_outcome: OnConflictPolicy;
  c6_match: boolean;
};

export type ShardATaxonomyResult = {
  primary: TaxonomyCell;
  secondary: TaxonomyCell[];
  identifier_conflicts: IdentifierConflictEntry[];
  c2_evidence: Array<{ kind: IdentifierKindBroad; value: string; other_group_ids: string[] }>;
};

export function assignShardATaxonomy(
  group: ShardAGroupInputs,
  crossGroupIndex: CrossGroupStrongIdIndex,
): ShardATaxonomyResult {
  const conflicts: IdentifierConflictEntry[] = [];
  const strongConflictKinds: IdentifierKindBroad[] = [];
  const weakConflictKinds: IdentifierKindBroad[] = [];
  const c2Evidence: ShardATaxonomyResult["c2_evidence"] = [];

  for (const r of group.identifier_authority_rows) {
    if (r.result !== "conflict") continue;
    const kind = canonicalizeKind(r.kind);
    const level = KIND_AUTHORITY_LEVEL[kind] ?? "weak";
    const c6 = detectC6(kind, r.conflict_values);
    const entry: IdentifierConflictEntry = {
      kind,
      values: [...r.conflict_values],
      members: [...r.conflict_members],
      authority_level: level,
      policy_outcome: ON_CONFLICT_DEFAULT[level],
      c6_match: c6,
    };
    conflicts.push(entry);
    if (STRONG_KINDS.has(kind)) {
      strongConflictKinds.push(kind);
      for (const v of r.conflict_values) {
        if (!v) continue;
        const others = crossGroupIndex.get(`${kind}|${v}`) ?? new Set<string>();
        const otherIds = [...others].filter((g) => g !== group.group_id);
        if (otherIds.length > 0) {
          c2Evidence.push({ kind, value: v, other_group_ids: otherIds });
        }
      }
    } else {
      weakConflictKinds.push(kind);
    }
  }

  const secondary: TaxonomyCell[] = [];
  let primary: TaxonomyCell;

  if (strongConflictKinds.length > 0) {
    primary = c2Evidence.length > 0 ? "C2" : "C1";
    if (c2Evidence.length > 0) secondary.push("C1");
    // C6 may still apply on weak kinds even when strong dominates.
    if (weakConflictKinds.length > 0 && conflicts.some((c) => c.c6_match)) secondary.push("C6");
    if (weakConflictKinds.length > 0 && !secondary.includes("C3")) secondary.push("C3");
  } else if (weakConflictKinds.length > 0) {
    if (conflicts.some((c) => c.c6_match)) {
      primary = "C6";
      secondary.push("C3");
    } else {
      primary = "C3";
    }
  } else if (group.block_reasons.includes("tied_composite") && conflicts.length === 0) {
    primary = "C7";
  } else if (group.any_hot_loser && conflicts.length === 0) {
    primary = "C8";
  } else {
    primary = "C7";
  }

  if (group.any_hot_loser && primary !== "C8") {
    if (!secondary.includes("C8")) secondary.push("C8");
  }
  if (group.block_reasons.includes("too_large") && !secondary.includes("too_large_marker" as never)) {
    // not a taxonomy cell, recorded in block_reasons separately
  }

  return {
    primary,
    secondary: secondary.filter((s) => s !== primary).sort((a, b) => cellRank(a) - cellRank(b)),
    identifier_conflicts: conflicts,
    c2_evidence: c2Evidence,
  };
}

// ── Taxonomy: Shard B ───────────────────────────────────────────────────────

export type ShardBOrphanInputs = {
  orphan_id: string;
  organization_id: string;
  store_id: string | null;
  external_winner_id: string | null;
  external_winner_candidates: string[];
  block_reasons: string[];
  orphan_most_recent_activity: string | null;
  identifier_conflicts_raw: Array<{ kind: string; values: string[]; members: string[] }>;
  external_winner_strong_identifier_kinds: string[];
  external_winner_deleted_or_merged: boolean;
};

export type ShardBTaxonomyResult = {
  primary: TaxonomyCell;
  secondary: TaxonomyCell[];
  identifier_conflicts: IdentifierConflictEntry[];
  external_winner_health: "single_healthy" | "single_unhealthy" | "ambiguous" | "missing";
};

export function assignShardBTaxonomy(orphan: ShardBOrphanInputs, hot: boolean): ShardBTaxonomyResult {
  const conflicts: IdentifierConflictEntry[] = orphan.identifier_conflicts_raw.map((c) => {
    const kind = canonicalizeKind(c.kind);
    const level = KIND_AUTHORITY_LEVEL[kind] ?? "weak";
    const c6 = detectC6(kind, c.values);
    return {
      kind,
      values: c.values,
      members: c.members,
      authority_level: level,
      policy_outcome: ON_CONFLICT_DEFAULT[level],
      c6_match: c6,
    };
  });

  let health: ShardBTaxonomyResult["external_winner_health"];
  if (orphan.external_winner_candidates.length === 0) health = "missing";
  else if (orphan.external_winner_candidates.length > 1) health = "ambiguous";
  else if (orphan.external_winner_deleted_or_merged) health = "single_unhealthy";
  else health = "single_healthy";

  const secondary: TaxonomyCell[] = [];
  let primary: TaxonomyCell;
  if (health === "ambiguous" || health === "missing" || health === "single_unhealthy") {
    primary = "C4";
    if (conflicts.some((c) => c.c6_match)) secondary.push("C6");
    if (conflicts.length > 0) secondary.push("C3");
  } else {
    // single_healthy
    const hasIdentifierConflict = conflicts.length > 0;
    if (hasIdentifierConflict) {
      primary = "C4";
    } else if (orphan.block_reasons.includes("orphan_has_recent_resolver_hits")) {
      primary = "C8";
    } else if (orphan.block_reasons.includes("orphan_has_recent_prices")) {
      primary = "C8";
    } else {
      primary = "C5";
    }
  }

  if (hot && primary !== "C8" && !secondary.includes("C8")) secondary.push("C8");

  return {
    primary,
    secondary: secondary.filter((s) => s !== primary).sort((a, b) => cellRank(a) - cellRank(b)),
    identifier_conflicts: conflicts,
    external_winner_health: health,
  };
}

// ── Authority matrix application ────────────────────────────────────────────

export type AuthorityDecision = {
  dispute_id: string;
  kind: IdentifierKindBroad;
  authority_level: AuthorityLevel;
  result: "adopted" | "dropped" | "escalated" | "absent";
  survived_value: string | null;
  dropped_values: string[];
  evidence_member_count: number;
  policy_rule_id: string;
};

/**
 * For a Shard A group: emit one AuthorityDecision per kind that has either an
 * `adopted` or `conflict` row in the input. Strong+conflict → escalated;
 * medium/weak+conflict → dropped per defaults.
 */
export function applyAuthorityMatrixA(args: {
  disputeId: string;
  authorityRows: readonly AuthorityCsvRow[];
}): AuthorityDecision[] {
  const out: AuthorityDecision[] = [];
  for (const r of args.authorityRows) {
    const kind = canonicalizeKind(r.kind);
    const level = KIND_AUTHORITY_LEVEL[kind] ?? "weak";
    if (r.result === "adopted") {
      out.push({
        dispute_id: args.disputeId,
        kind,
        authority_level: level,
        result: "adopted",
        survived_value: r.winner_value || null,
        dropped_values: [],
        evidence_member_count: r.contributing_members.length,
        policy_rule_id: `next_18l_default_v1:${kind}:${level}:adopt`,
      });
    } else if (r.result === "conflict") {
      const policy = ON_CONFLICT_DEFAULT[level];
      out.push({
        dispute_id: args.disputeId,
        kind,
        authority_level: level,
        result: policy === "escalate" ? "escalated" : "dropped",
        survived_value: null,
        dropped_values: [...r.conflict_values],
        evidence_member_count: r.conflict_members.length,
        policy_rule_id: `next_18l_default_v1:${kind}:${level}:${policy}`,
      });
    }
  }
  return out;
}

/**
 * For a Shard B orphan: emit one AuthorityDecision per kind that appears in
 * identifier_conflicts_raw. NEXT-18M does not have full identifier coverage
 * for non-conflicting kinds in 07-shardB CSV, so only conflicting kinds are
 * decided. Absent kinds are recorded as result="absent" with the policy rule
 * id for the connector-neutral default.
 */
export function applyAuthorityMatrixB(args: {
  disputeId: string;
  conflicts: readonly IdentifierConflictEntry[];
}): AuthorityDecision[] {
  return args.conflicts.map((c) => ({
    dispute_id: args.disputeId,
    kind: c.kind,
    authority_level: c.authority_level,
    result: c.policy_outcome === "escalate" ? "escalated" : "dropped",
    survived_value: null,
    dropped_values: [...c.values],
    evidence_member_count: c.members.length,
    policy_rule_id: `next_18l_default_v1:${c.kind}:${c.authority_level}:${c.policy_outcome}`,
  }));
}

// ── Hot-loser flag + reversibility window ───────────────────────────────────

export function daysSince(timestampIso: string | null, nowIso: string): number | null {
  if (!timestampIso) return null;
  const t = Date.parse(timestampIso);
  const n = Date.parse(nowIso);
  if (Number.isNaN(t) || Number.isNaN(n)) return null;
  return Math.floor((n - t) / 86400000);
}

export function resolveHotAndWindow(args: {
  anyHotLoser: boolean | null;
  orphanMostRecentActivity?: string | null;
  hotThresholdDays: number;
  baseReversibilityWindowH: number;
  nowIso: string;
}): { hot_loser_flag: boolean; reversibility_window_h: number; days_since_activity: number | null } {
  let hot = false;
  let daysSinceActivity: number | null = null;
  if (args.anyHotLoser != null) {
    hot = args.anyHotLoser === true;
  }
  if (args.orphanMostRecentActivity !== undefined) {
    daysSinceActivity = daysSince(args.orphanMostRecentActivity, args.nowIso);
    if (daysSinceActivity != null && daysSinceActivity <= args.hotThresholdDays) hot = true;
  }
  const window = hot ? args.baseReversibilityWindowH * 2 : args.baseReversibilityWindowH;
  return { hot_loser_flag: hot, reversibility_window_h: window, days_since_activity: daysSinceActivity };
}

// ── AI advisory placeholder (S.2) ───────────────────────────────────────────

export type AiAdvicePlaceholder = {
  normalization_suggestions: never[];
  winner_recommendation: null;
  vendor_lineage_inference: null;
  similarity_clustering: null;
  last_advised_at: null;
  last_advised_by_model: null;
  advisory_only: true;
};

export function emptyAiAdvice(): AiAdvicePlaceholder {
  return {
    normalization_suggestions: [],
    winner_recommendation: null,
    vendor_lineage_inference: null,
    similarity_clustering: null,
    last_advised_at: null,
    last_advised_by_model: null,
    advisory_only: true,
  };
}

// ── Surviving identifier set + dropped kinds helpers ────────────────────────

export function buildSurvivingIdentifierSet(
  decisions: readonly AuthorityDecision[],
): { surviving_identifier_set: Record<string, string>; dropped_identifier_kinds: IdentifierKindBroad[] } {
  const surviving: Record<string, string> = {};
  const dropped: IdentifierKindBroad[] = [];
  for (const d of decisions) {
    if (d.result === "adopted" && d.survived_value) surviving[d.kind] = d.survived_value;
    else if (d.result === "dropped") dropped.push(d.kind);
  }
  return { surviving_identifier_set: surviving, dropped_identifier_kinds: dropped };
}

// ── Dispute candidate shape ─────────────────────────────────────────────────

export type DisputeStatus = "open" | "claimed" | "decided" | "committed" | "dismissed" | "reverted";
export type TriggeredByKind = "operator" | "automation" | "ai_assist" | "pipeline_retry";

export type DisputeCandidate = {
  dispute_id: string;
  organization_id: string;
  store_id: string | null;
  shard: "A" | "B";
  group_id: string | null;
  orphan_id: string | null;
  taxonomy_cell: TaxonomyCell;
  secondary_cells: TaxonomyCell[];
  members: string[];
  member_count: number;
  recommended_winner_id: string | null;
  winner_selection_method: "next_18k_ladder" | "single_external_match" | "deferred_human_review";
  surviving_identifier_set: Record<string, string>;
  dropped_identifier_kinds: IdentifierKindBroad[];
  identifier_conflicts: IdentifierConflictEntry[];
  proposed_authority_decisions: AuthorityDecision[];
  hot_loser_flag: boolean;
  reversibility_window_h: number;
  days_since_activity: number | null;
  block_reasons: string[];
  cluster_overlap_count: number;
  mismatch_overlap_count: number;
  total_downstream_rewrites: number;
  total_prices_inherited: number;
  status: DisputeStatus;
  detected_at: string;
  detected_by_run_id: string;
  detected_by_kind: TriggeredByKind;
  ai_advice: AiAdvicePlaceholder;
};

export const __testables = {
  stripLeadingZeros,
  collapseMfgPart,
  sha256_32,
};
