/**
 * NEXT-18K — Pure helpers for the merge-candidate / canonical-winner audit.
 *
 * Read-only by construction (no Supabase imports, no filesystem side effects).
 * Every function is deterministic so the same NEXT-18J snapshot and same DB
 * aggregates produce identical scores, winners, edges, and reasoning JSON.
 *
 * Exposed surface (consumed by scripts/product-seed-merge-winner.ts):
 *   - DOWNSTREAM_SURFACES, DIMENSION_NAMES, DIMENSION_WEIGHTS (config)
 *   - computeRawScores / normalizeScoresInGroup / weightedScores / compositeScore
 *   - buildIdentifierAuthority (winner_identifier_set + identifier_conflicts)
 *   - selectShardAWinner (composite + 6-step tiebreak ladder + safe_to_merge gating)
 *   - buildMergeEdge (loser→winner edge with downstream rewrite + cascade risk + imap_action)
 *   - buildEvidenceSnapshot (J17 source)
 *   - buildReasoning (J16 source)
 *   - shardBClassify (orphan vs external-winner pair scorer + gating)
 *
 * Schema notes:
 *   - product_prices has FK ON DELETE CASCADE → soft-delete losers only.
 *   - merged_into_id is ON DELETE SET NULL → winner deletion would re-orphan losers.
 *   - All identifier authority kinds use lib/audits/product-seed-backfill-dryrun normalization.
 */

import {
  IDENTIFIER_KINDS,
  deriveCandidates,
  strongShapeValidCandidates,
  type Candidates,
  type IdentifierKind,
} from "./product-seed-backfill-dryrun";
import { daysBetween, type ActiveMapRow, type ProductRow } from "./product-seed-orphan-sizing";

// ── Config ──────────────────────────────────────────────────────────────────

export const DOWNSTREAM_SURFACES = [
  "product_prices",
  "amazon_reports_repository",
  "amazon_inventory_ledger",
  "amazon_all_orders",
  "amazon_settlements",
  "amazon_transactions",
  "amazon_manage_fba_inventory",
  "amazon_amazon_fulfilled_inventory",
] as const;
export type SurfaceName = (typeof DOWNSTREAM_SURFACES)[number];

/** Surfaces whose link column is `product_id` (vs `resolved_product_id`). */
export const PRODUCT_ID_SURFACES: ReadonlySet<SurfaceName> = new Set([
  "product_prices",
  "amazon_reports_repository",
]);

export type SurfaceAggregate = {
  row_count: number;
  /** ISO timestamptz string or null if surface had no rows for this member. */
  max_event_time: string | null;
};

export type MemberDownstream = Record<SurfaceName, SurfaceAggregate>;

export function emptyDownstream(): MemberDownstream {
  const out = {} as MemberDownstream;
  for (const s of DOWNSTREAM_SURFACES) out[s] = { row_count: 0, max_event_time: null };
  return out;
}

export const DIMENSION_NAMES = [
  "identifier_authority_score",
  "operational_recency_score",
  "downstream_link_count",
  "product_prices_count",
  "imap_history_score",
  "catalog_bridge_score",
  "cluster_membership_penalty",
  "mismatch_penalty",
  "title_quality_score",
  "age_score",
] as const;
export type DimensionName = (typeof DIMENSION_NAMES)[number];

export const DIMENSION_WEIGHTS: Readonly<Record<DimensionName, number>> = {
  identifier_authority_score: 5,
  operational_recency_score: 4,
  downstream_link_count: 3,
  product_prices_count: 2,
  imap_history_score: 2,
  catalog_bridge_score: 1,
  cluster_membership_penalty: -5,
  mismatch_penalty: -3,
  title_quality_score: 1,
  age_score: 1,
};

export type RawScores = Record<DimensionName, number>;
export type NormalizedScores = Record<DimensionName, number>;
export type WeightedScores = Record<DimensionName, number>;

// ── Score primitives ────────────────────────────────────────────────────────

export type ScoreInputs = {
  product: ProductRow;
  candidates: Candidates;
  activeImapCount: number;
  inactiveImapCount: number;
  hasCatalogBridge: boolean;
  inCluster: boolean;
  inMismatch: boolean;
  downstream: MemberDownstream;
  nowIso: string;
};

function maxIso(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (best == null || v > best) best = v;
  }
  return best;
}

/**
 * Recency bucket over the most-recent activity timestamp.
 *   0  → null
 *   1  → > 365 days old
 *   2  → 181–365 days
 *   3  → 91–180 days
 *   4  → 31–90 days
 *   5  → ≤ 30 days
 */
export function recencyBucket(timestampIso: string | null, nowIso: string): number {
  if (!timestampIso) return 0;
  const days = daysBetween(nowIso, timestampIso);
  if (days == null || days < 0) return 0;
  if (days <= 30) return 5;
  if (days <= 90) return 4;
  if (days <= 180) return 3;
  if (days <= 365) return 2;
  return 1;
}

/**
 * Age bucket — older rows score higher because the older PID likely accreted
 * more activity. Mirror of recencyBucket on created_at.
 *   0 → null
 *   1 → ≤ 90 days
 *   2 → 91–365 days
 *   3 → > 365 days
 */
export function ageBucket(ageDays: number | null): number {
  if (ageDays == null || ageDays < 0) return 0;
  if (ageDays <= 90) return 1;
  if (ageDays <= 365) return 2;
  return 3;
}

export function titleQualityScore(product: ProductRow): number {
  let s = 0;
  if (product.product_name && product.product_name.trim().length > 0) s++;
  if (product.brand && product.brand.trim().length > 0) s++;
  if (product.vendor_name && product.vendor_name.trim().length > 0) s++;
  if (product.mfg_part_number && product.mfg_part_number.trim().length > 0) s++;
  return Math.min(s, 3);
}

export function memberMostRecentActivity(
  product: ProductRow,
  downstream: MemberDownstream,
): string | null {
  const surfaceMax = (Object.values(downstream) as SurfaceAggregate[])
    .map((s) => s.max_event_time)
    .filter((v): v is string => v != null);
  return maxIso(
    product.last_seen_at,
    product.last_catalog_sync_at,
    product.updated_at,
    ...surfaceMax,
  );
}

export function computeRawScores(inputs: ScoreInputs): RawScores {
  const strongCount = strongShapeValidCandidates(inputs.candidates).length;
  const productsRecency = maxIso(
    inputs.product.last_seen_at,
    inputs.product.last_catalog_sync_at,
    inputs.product.updated_at,
  );
  const downstreamRecency = (Object.values(inputs.downstream) as SurfaceAggregate[])
    .map((s) => s.max_event_time)
    .filter((v): v is string => v != null)
    .sort()
    .pop() ?? null;
  const recencyMax = maxIso(productsRecency, downstreamRecency);

  const ageDays = daysBetween(inputs.nowIso, inputs.product.created_at);
  const downstreamSum = (Object.values(inputs.downstream) as SurfaceAggregate[]).reduce(
    (a, s) => a + s.row_count,
    0,
  );

  return {
    identifier_authority_score: strongCount,
    operational_recency_score: recencyBucket(recencyMax, inputs.nowIso),
    downstream_link_count: downstreamSum,
    product_prices_count: inputs.downstream.product_prices.row_count,
    imap_history_score: inputs.activeImapCount + 0.25 * inputs.inactiveImapCount,
    catalog_bridge_score: inputs.hasCatalogBridge ? 1 : 0,
    cluster_membership_penalty: inputs.inCluster ? 1 : 0,
    mismatch_penalty: inputs.inMismatch ? 1 : 0,
    title_quality_score: titleQualityScore(inputs.product),
    age_score: ageBucket(ageDays),
  };
}

/**
 * Linear normalization of each dimension to [0,1] within a group. Ties (all
 * members equal) map to 0.5 so the dimension contributes zero net signal.
 */
export function normalizeScoresInGroup(rawByMember: Map<string, RawScores>): Map<string, NormalizedScores> {
  const out = new Map<string, NormalizedScores>();
  const ids = [...rawByMember.keys()];
  if (ids.length === 0) return out;

  const dimMin: Record<DimensionName, number> = {} as Record<DimensionName, number>;
  const dimMax: Record<DimensionName, number> = {} as Record<DimensionName, number>;
  for (const d of DIMENSION_NAMES) {
    let mn = Infinity;
    let mx = -Infinity;
    for (const id of ids) {
      const v = rawByMember.get(id)![d];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    dimMin[d] = mn;
    dimMax[d] = mx;
  }

  for (const id of ids) {
    const raw = rawByMember.get(id)!;
    const norm: NormalizedScores = {} as NormalizedScores;
    for (const d of DIMENSION_NAMES) {
      if (dimMax[d] === dimMin[d]) {
        norm[d] = 0.5;
      } else {
        norm[d] = (raw[d] - dimMin[d]) / (dimMax[d] - dimMin[d]);
      }
    }
    out.set(id, norm);
  }
  return out;
}

export function weightedScores(normalized: NormalizedScores): WeightedScores {
  const out: WeightedScores = {} as WeightedScores;
  for (const d of DIMENSION_NAMES) {
    out[d] = normalized[d] * DIMENSION_WEIGHTS[d];
  }
  return out;
}

export function compositeScore(weighted: WeightedScores): number {
  let s = 0;
  for (const d of DIMENSION_NAMES) s += weighted[d];
  return s;
}

// ── Identifier authority hierarchy ──────────────────────────────────────────

export type IdentifierAuthority = {
  winner_identifier_set: Partial<Record<IdentifierKind, string>>;
  contributing_members: Partial<Record<IdentifierKind, string[]>>;
  identifier_conflicts: Array<{ kind: IdentifierKind; values: string[]; members: string[] }>;
};

export function buildIdentifierAuthority(
  candidatesByMember: Map<string, Candidates>,
): IdentifierAuthority {
  const winner_identifier_set: IdentifierAuthority["winner_identifier_set"] = {};
  const contributing_members: IdentifierAuthority["contributing_members"] = {};
  const identifier_conflicts: IdentifierAuthority["identifier_conflicts"] = [];
  for (const kind of IDENTIFIER_KINDS) {
    const byValue = new Map<string, string[]>();
    for (const [pid, cands] of candidatesByMember) {
      const c = cands[kind];
      if (!c || !c.shape_valid || !c.normalized) continue;
      const arr = byValue.get(c.normalized);
      if (arr) arr.push(pid);
      else byValue.set(c.normalized, [pid]);
    }
    const values = [...byValue.keys()].sort();
    if (values.length === 0) continue;
    if (values.length === 1) {
      winner_identifier_set[kind] = values[0];
      contributing_members[kind] = [...byValue.get(values[0])!].sort();
    } else {
      const members = new Set<string>();
      for (const v of values) for (const m of byValue.get(v)!) members.add(m);
      identifier_conflicts.push({ kind, values, members: [...members].sort() });
    }
  }
  return { winner_identifier_set, contributing_members, identifier_conflicts };
}

// ── Shard A winner selection ────────────────────────────────────────────────

export type WinnerSelectionInput = {
  groupId: string;
  members: string[];
  rawByMember: Map<string, RawScores>;
  normalizedByMember: Map<string, NormalizedScores>;
  weightedByMember: Map<string, WeightedScores>;
  compositeByMember: Map<string, number>;
  productById: Map<string, ProductRow>;
  candidatesByMember: Map<string, Candidates>;
  downstreamByMember: Map<string, MemberDownstream>;
  inClusterByMember: Map<string, boolean>;
  inMismatchByMember: Map<string, boolean>;
  identifierAuthority: IdentifierAuthority;
  maxGroupSize: number;
};

export type BlockReasonA =
  | "cluster_member"
  | "mismatch_member"
  | "too_large"
  | "identifier_conflict"
  | "tied_composite"
  | "upc_only_winner"
  | "no_strong_id_member";

export type TiebreakStep =
  | { dimension: DimensionName | "composite"; winner_value: number; runner_up_value: number }
  | { dimension: "product_id_lex"; winner_value: string; runner_up_value: string };

export type WinnerSelection = {
  groupId: string;
  winnerId: string;
  rankedMembers: string[];
  safeToMerge: boolean;
  blockReasons: BlockReasonA[];
  tiebreakPath: TiebreakStep[];
  scoreMargin: number;
  identifierAuthority: IdentifierAuthority;
};

function cmpByCompositeDesc(
  a: string,
  b: string,
  composite: Map<string, number>,
): number {
  const ca = composite.get(a) ?? 0;
  const cb = composite.get(b) ?? 0;
  if (ca !== cb) return cb - ca;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic tiebreak ladder when composite scores match:
 *   identifier_authority → downstream_link_count → operational_recency_max →
 *   product_prices_count → imap_history_score → age → product_id (lex).
 */
const TIEBREAK_DIMS: readonly DimensionName[] = [
  "identifier_authority_score",
  "downstream_link_count",
  "operational_recency_score",
  "product_prices_count",
  "imap_history_score",
  "age_score",
];

export function selectShardAWinner(input: WinnerSelectionInput): WinnerSelection {
  const ranked = [...input.members].sort((a, b) =>
    cmpByCompositeDesc(a, b, input.compositeByMember),
  );
  if (ranked.length === 0) {
    throw new Error(`[NEXT-18K] selectShardAWinner: empty group ${input.groupId}`);
  }

  const tiebreakPath: TiebreakStep[] = [];
  let winnerId = ranked[0];

  // If composite is tied at the top, walk the ladder.
  const topComposite = input.compositeByMember.get(winnerId) ?? 0;
  const topTies = ranked.filter((id) => (input.compositeByMember.get(id) ?? 0) === topComposite);
  if (topTies.length > 1) {
    let candidates = topTies.slice();
    for (const dim of TIEBREAK_DIMS) {
      if (candidates.length <= 1) break;
      const valByMember = new Map(
        candidates.map((id) => [id, input.rawByMember.get(id)![dim]] as const),
      );
      const bestVal = Math.max(...valByMember.values());
      const filtered = candidates.filter((id) => valByMember.get(id) === bestVal);
      if (filtered.length < candidates.length) {
        const runnerUpVal = Math.max(
          ...candidates.filter((id) => !filtered.includes(id)).map((id) => valByMember.get(id) ?? -Infinity),
        );
        tiebreakPath.push({
          dimension: dim,
          winner_value: bestVal,
          runner_up_value: Number.isFinite(runnerUpVal) ? runnerUpVal : bestVal,
        });
      }
      candidates = filtered;
    }
    if (candidates.length > 1) {
      const sorted = [...candidates].sort();
      tiebreakPath.push({
        dimension: "product_id_lex",
        winner_value: sorted[0],
        runner_up_value: sorted[1],
      });
      candidates = [sorted[0]];
    }
    winnerId = candidates[0];
    // Rebuild ranked so winner is first; rest keep composite order.
    ranked.splice(ranked.indexOf(winnerId), 1);
    ranked.unshift(winnerId);
  }

  const winnerComposite = input.compositeByMember.get(winnerId) ?? 0;
  const runnerUpId = ranked.length > 1 ? ranked[1] : null;
  const runnerUpComposite = runnerUpId ? (input.compositeByMember.get(runnerUpId) ?? 0) : winnerComposite;
  const scoreMargin = winnerComposite - runnerUpComposite;

  // Safe-to-merge gating.
  const blockReasons: BlockReasonA[] = [];
  if (input.members.some((m) => input.inClusterByMember.get(m))) blockReasons.push("cluster_member");
  if (input.members.some((m) => input.inMismatchByMember.get(m))) blockReasons.push("mismatch_member");
  if (input.members.length > input.maxGroupSize) blockReasons.push("too_large");
  if (input.identifierAuthority.identifier_conflicts.length > 0) blockReasons.push("identifier_conflict");
  if (runnerUpId && scoreMargin <= 0) blockReasons.push("tied_composite");
  const winnerCandidates = input.candidatesByMember.get(winnerId)!;
  const winnerStrong = strongShapeValidCandidates(winnerCandidates).map((c) => c.kind);
  if (winnerStrong.length === 1 && winnerStrong[0] === "upc") blockReasons.push("upc_only_winner");
  if (winnerStrong.length === 0) blockReasons.push("no_strong_id_member");
  for (const m of input.members) {
    const c = input.candidatesByMember.get(m)!;
    if (strongShapeValidCandidates(c).length === 0) {
      if (!blockReasons.includes("no_strong_id_member")) blockReasons.push("no_strong_id_member");
      break;
    }
  }

  return {
    groupId: input.groupId,
    winnerId,
    rankedMembers: ranked,
    safeToMerge: blockReasons.length === 0,
    blockReasons,
    tiebreakPath,
    scoreMargin,
    identifierAuthority: input.identifierAuthority,
  };
}

// ── Merge-edge construction ─────────────────────────────────────────────────

export type ImapAction = "rewrite_product_id" | "create_winner_imap_row" | "no_imap_action";

export type MergeEdge = {
  group_id: string;
  loser_id: string;
  winner_id: string;
  organization_id: string;
  store_id: string | null;
  downstream_rewrite_count: number;
  cascade_delete_risk: number;
  imap_action: ImapAction;
  cycle_check_pass: boolean;
  merged_into_chain_depth_after_merge: number;
  proposed_loser_state: { merge_status: "merged"; merged_into_id: string };
  per_surface_rewrite_counts: Record<SurfaceName, number>;
  hot_loser_flag: boolean;
  most_recent_activity_across_surfaces: string | null;
};

export function buildMergeEdge(args: {
  groupId: string;
  winner: ProductRow;
  loser: ProductRow;
  loserDownstream: MemberDownstream;
  loserActiveImapCount: number;
  winnerActiveImapCount: number;
  cycleCheckPass: boolean;
  hotThresholdDays: number;
  nowIso: string;
}): MergeEdge {
  const perSurface: Record<SurfaceName, number> = {} as Record<SurfaceName, number>;
  let total = 0;
  for (const s of DOWNSTREAM_SURFACES) {
    const n = args.loserDownstream[s].row_count;
    perSurface[s] = n;
    total += n;
  }
  const recent = memberMostRecentActivity(args.loser, args.loserDownstream);
  const days = recent ? daysBetween(args.nowIso, recent) : null;
  const hot = days != null && days <= args.hotThresholdDays;
  let imapAction: ImapAction;
  if (args.loserActiveImapCount > 0) imapAction = "rewrite_product_id";
  else if (args.winnerActiveImapCount === 0) imapAction = "create_winner_imap_row";
  else imapAction = "no_imap_action";

  return {
    group_id: args.groupId,
    loser_id: args.loser.id,
    winner_id: args.winner.id,
    organization_id: args.loser.organization_id,
    store_id: args.loser.store_id,
    downstream_rewrite_count: total,
    cascade_delete_risk: args.loserDownstream.product_prices.row_count,
    imap_action: imapAction,
    cycle_check_pass: args.cycleCheckPass,
    merged_into_chain_depth_after_merge: 1,
    proposed_loser_state: { merge_status: "merged", merged_into_id: args.winner.id },
    per_surface_rewrite_counts: perSurface,
    hot_loser_flag: hot,
    most_recent_activity_across_surfaces: recent,
  };
}

// ── Evidence snapshot + reasoning JSON (J16 / J17) ──────────────────────────

export type EvidenceSnapshot = {
  product_id: string;
  merge_status: string | null;
  merged_into_id: string | null;
  deleted_at: string | null;
  sku: string | null;
  asin: string | null;
  fnsku: string | null;
  upc_code: string | null;
  mfg_part_number: string | null;
  barcode: string | null;
  product_name: string | null;
  brand: string | null;
  vendor_name: string | null;
  organization_id: string;
  store_id: string | null;
  created_at: string | null;
  captured_at: string;
};

export function buildEvidenceSnapshot(product: ProductRow, capturedAtIso: string): EvidenceSnapshot {
  return {
    product_id: product.id,
    merge_status: product.merge_status,
    merged_into_id: product.merged_into_id,
    deleted_at: product.deleted_at,
    sku: product.sku,
    asin: product.asin,
    fnsku: product.fnsku,
    upc_code: product.upc_code,
    mfg_part_number: product.mfg_part_number,
    barcode: product.barcode,
    product_name: product.product_name,
    brand: product.brand,
    vendor_name: product.vendor_name,
    organization_id: product.organization_id,
    store_id: product.store_id,
    created_at: product.created_at,
    captured_at: capturedAtIso,
  };
}

export type Reasoning = {
  score_breakdown: Record<
    DimensionName,
    { raw: number; normalized: number; weighted: number; weight: number }
  >;
  composite_score: number;
  tiebreak_path: TiebreakStep[];
  block_reason_chain: string[];
};

export function buildReasoning(args: {
  raw: RawScores;
  normalized: NormalizedScores;
  weighted: WeightedScores;
  composite: number;
  tiebreakPath: TiebreakStep[];
  blockReasons: readonly string[];
}): Reasoning {
  const score_breakdown = {} as Reasoning["score_breakdown"];
  for (const d of DIMENSION_NAMES) {
    score_breakdown[d] = {
      raw: args.raw[d],
      normalized: args.normalized[d],
      weighted: args.weighted[d],
      weight: DIMENSION_WEIGHTS[d],
    };
  }
  return {
    score_breakdown,
    composite_score: args.composite,
    tiebreak_path: args.tiebreakPath,
    block_reason_chain: [...args.blockReasons],
  };
}

// ── Shard B (orphan vs external winner) ─────────────────────────────────────

export type BlockReasonB =
  | "external_winner_missing"
  | "external_winner_deleted_or_merged"
  | "external_winner_ambiguous"
  | "external_winner_no_strong_id"
  | "orphan_has_recent_resolver_hits"
  | "identifier_conflict_with_external_winner"
  | "orphan_has_recent_prices";

export type ShardBClassification = {
  orphan_id: string;
  external_winner_id: string | null;
  external_winner_candidates: string[];
  safe_to_merge: boolean;
  block_reasons: BlockReasonB[];
  identifier_authority: IdentifierAuthority;
  orphan_raw: RawScores;
  external_raw: RawScores | null;
  orphan_normalized: NormalizedScores;
  external_normalized: NormalizedScores | null;
  orphan_weighted: WeightedScores;
  external_weighted: WeightedScores | null;
  orphan_composite: number;
  external_composite: number | null;
  per_surface_rewrite_counts: Record<SurfaceName, number>;
  downstream_rewrite_count: number;
  cascade_delete_risk: number;
  prices_max_observed_at: string | null;
  orphan_most_recent_activity: string | null;
};

export function classifyShardB(args: {
  orphanInputs: ScoreInputs;
  externalWinner: ProductRow | null;
  externalWinnerCandidates: string[]; // distinct ids found in collision_evidence
  externalInputs: ScoreInputs | null;
  pricesRecentThresholdDays: number;
  resolverHitThresholdDays: number;
  nowIso: string;
}): ShardBClassification {
  const orphan = args.orphanInputs.product;
  const candidatesByMember = new Map<string, Candidates>();
  candidatesByMember.set(orphan.id, args.orphanInputs.candidates);
  if (args.externalWinner && args.externalInputs) {
    candidatesByMember.set(args.externalWinner.id, args.externalInputs.candidates);
  }
  const identifierAuthority = buildIdentifierAuthority(candidatesByMember);

  // Compute raw + (normalize against pair) for both members.
  const orphanRaw = computeRawScores(args.orphanInputs);
  const externalRaw = args.externalInputs ? computeRawScores(args.externalInputs) : null;
  const rawByMember = new Map<string, RawScores>([[orphan.id, orphanRaw]]);
  if (args.externalWinner && externalRaw) rawByMember.set(args.externalWinner.id, externalRaw);
  const normMap = normalizeScoresInGroup(rawByMember);
  const orphanNorm = normMap.get(orphan.id)!;
  const externalNorm = args.externalWinner ? normMap.get(args.externalWinner.id) ?? null : null;
  const orphanWeighted = weightedScores(orphanNorm);
  const externalWeighted = externalNorm ? weightedScores(externalNorm) : null;
  const orphanComposite = compositeScore(orphanWeighted);
  const externalComposite = externalWeighted ? compositeScore(externalWeighted) : null;

  const perSurface: Record<SurfaceName, number> = {} as Record<SurfaceName, number>;
  let totalDownstream = 0;
  for (const s of DOWNSTREAM_SURFACES) {
    const n = args.orphanInputs.downstream[s].row_count;
    perSurface[s] = n;
    totalDownstream += n;
  }
  const orphanRecent = memberMostRecentActivity(orphan, args.orphanInputs.downstream);
  const pricesObserved = args.orphanInputs.downstream.product_prices.max_event_time;

  const blockReasons: BlockReasonB[] = [];

  if (args.externalWinnerCandidates.length === 0) {
    blockReasons.push("external_winner_missing");
  } else if (args.externalWinnerCandidates.length > 1) {
    blockReasons.push("external_winner_ambiguous");
  } else if (!args.externalWinner) {
    blockReasons.push("external_winner_missing");
  } else if (
    args.externalWinner.deleted_at != null ||
    (args.externalWinner.merge_status != null && args.externalWinner.merge_status !== "active")
  ) {
    blockReasons.push("external_winner_deleted_or_merged");
  }

  if (args.externalWinner && args.externalInputs) {
    const strong = strongShapeValidCandidates(args.externalInputs.candidates);
    if (strong.length === 0) blockReasons.push("external_winner_no_strong_id");
  }

  // Resolver-hit gating uses only resolver surfaces (the 6 Amazon ops tables, NOT product_prices).
  const resolverHitSurfaces: SurfaceName[] = [
    "amazon_inventory_ledger",
    "amazon_all_orders",
    "amazon_settlements",
    "amazon_transactions",
    "amazon_manage_fba_inventory",
    "amazon_amazon_fulfilled_inventory",
  ];
  const totalResolverHits = resolverHitSurfaces.reduce(
    (a, s) => a + args.orphanInputs.downstream[s].row_count,
    0,
  );
  const maxResolverRecency = maxIso(
    ...resolverHitSurfaces.map((s) => args.orphanInputs.downstream[s].max_event_time),
  );
  const resolverRecencyDays = maxResolverRecency ? daysBetween(args.nowIso, maxResolverRecency) : null;
  if (
    totalResolverHits > 0 &&
    (resolverRecencyDays == null || resolverRecencyDays <= args.resolverHitThresholdDays)
  ) {
    blockReasons.push("orphan_has_recent_resolver_hits");
  }

  const pricesDays = pricesObserved ? daysBetween(args.nowIso, pricesObserved) : null;
  if (
    args.orphanInputs.downstream.product_prices.row_count > 0 &&
    (pricesDays == null || pricesDays <= args.pricesRecentThresholdDays)
  ) {
    blockReasons.push("orphan_has_recent_prices");
  }

  if (identifierAuthority.identifier_conflicts.length > 0) {
    blockReasons.push("identifier_conflict_with_external_winner");
  }

  return {
    orphan_id: orphan.id,
    external_winner_id: args.externalWinner?.id ?? null,
    external_winner_candidates: [...args.externalWinnerCandidates].sort(),
    safe_to_merge: blockReasons.length === 0,
    block_reasons: blockReasons,
    identifier_authority: identifierAuthority,
    orphan_raw: orphanRaw,
    external_raw: externalRaw,
    orphan_normalized: orphanNorm,
    external_normalized: externalNorm,
    orphan_weighted: orphanWeighted,
    external_weighted: externalWeighted,
    orphan_composite: orphanComposite,
    external_composite: externalComposite,
    per_surface_rewrite_counts: perSurface,
    downstream_rewrite_count: totalDownstream,
    cascade_delete_risk: args.orphanInputs.downstream.product_prices.row_count,
    prices_max_observed_at: pricesObserved,
    orphan_most_recent_activity: orphanRecent,
  };
}

// ── Re-exports for orchestrator convenience ─────────────────────────────────

export { deriveCandidates, strongShapeValidCandidates } from "./product-seed-backfill-dryrun";
export type { Candidates, IdentifierKind } from "./product-seed-backfill-dryrun";
export type { ProductRow, ActiveMapRow } from "./product-seed-orphan-sizing";
