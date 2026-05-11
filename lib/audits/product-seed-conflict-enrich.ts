/**
 * NEXT-18G — Pure helpers for the conflict-cluster enrichment pass.
 *
 * No Supabase imports. No Node-fs imports beyond `node:fs` for JSON loading.
 * Every function is unit-testable in isolation. The script orchestrator owns
 * the DB I/O and chunked .in() SELECTs.
 *
 * Public surface:
 *   - loadClustersFromJson      — parse NEXT-18F 01-conflict-clusters.json
 *   - extractDistinctProductIds — sorted union of every conflicting_product_id
 *   - deriveTenant              — pull the single (org, store) from evidence rows
 *   - chunkIds                  — split an id array into PostgREST-safe chunks
 *   - buildEnrichedCluster      — assemble per-cluster snapshot + computed signals
 *   - computeLikelySameProductHint — deterministic hint + reasons
 *   - titleSimilarity3Gram      — token 3-gram Jaccard similarity
 */

import * as fs from "node:fs";

export const HINT_LEVELS = ["yes_high", "yes_medium", "uncertain", "no_low"] as const;
export type LikelyHint = (typeof HINT_LEVELS)[number];

export const SEVERITY_LEVELS = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

export const POSTGREST_IN_CHUNK_SIZE = 200;

/** Shape carried over from NEXT-18F 01-conflict-clusters.json. We only depend on
 *  fields the enrichment actually reads, but pass-through the rest as `extra`. */
export type ClusterInput = {
  cluster_id: string;
  clusterKey: string;
  identifiers: { asin: string; fnsku: string; seller_sku: string };
  partial_triad: boolean;
  rows_seen_total: number;
  rows_seen_by_source_table: Record<string, number>;
  source_tables_seen: string[];
  distinct_conflicting_product_ids: number;
  conflicting_product_ids: string[];
  non_f2_conflict_present: boolean;
  evidence_rows: Array<{
    source_table: string;
    source_row_id: string;
    run_id: string;
    organization_id: string | null;
    store_id: string | null;
    title: string | null;
    primary_reason: string | null;
    match_rank: number | null;
    shape: Record<string, string> | null;
    upload_id_value: string | null;
    origin: string;
  }>;
  titles_seen_count: number;
  titles_seen: Array<{ title: string; count: number }>;
  titles_top1: string;
  titles_top2: string;
  vendor_hint: string;
  severity: Severity;
  severity_reasons: string[];
  recommended_review_action: string;
  /** Catch-all for forward-compat. */
  [k: string]: unknown;
};

export function loadClustersFromJson(filePath: string): ClusterInput[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `[enrich] expected an array at ${filePath}, got ${typeof parsed}`,
    );
  }
  return parsed as ClusterInput[];
}

export function extractDistinctProductIds(clusters: ClusterInput[]): string[] {
  const set = new Set<string>();
  for (const c of clusters) {
    for (const pid of c.conflicting_product_ids) {
      if (typeof pid === "string" && pid.length > 0) set.add(pid);
    }
  }
  return [...set].sort();
}

export type DerivedTenant = {
  organization_id: string;
  store_ids: string[];
  trace: string[];
};

/**
 * Walk every evidence_rows[*].organization_id and return the single org, or
 * throw if more than one is present. The reviewer must supply --organization-id
 * to force a choice.
 */
export function deriveTenant(
  clusters: ClusterInput[],
  override: string | null,
): DerivedTenant {
  const trace: string[] = [];
  const orgs = new Set<string>();
  const stores = new Set<string>();
  for (const c of clusters) {
    for (const er of c.evidence_rows) {
      if (er.organization_id) orgs.add(er.organization_id);
      if (er.store_id) stores.add(er.store_id);
    }
  }
  trace.push(
    `[tenant] discovered ${orgs.size} organization(s) and ${stores.size} store(s) across input clusters`,
  );
  if (override) {
    if (!orgs.has(override) && orgs.size > 0) {
      trace.push(
        `[tenant] --organization-id=${override} is NOT in discovered set ${[...orgs].join(",")}; trusting override anyway`,
      );
    }
    trace.push(`[tenant] using --organization-id=${override}`);
    return { organization_id: override, store_ids: [...stores], trace };
  }
  if (orgs.size === 0) {
    throw new Error(
      "[enrich] cannot derive tenant: no evidence_rows[*].organization_id present in input clusters",
    );
  }
  if (orgs.size > 1) {
    throw new Error(
      `[enrich] multi-org input (${[...orgs].join(",")}) requires explicit --organization-id`,
    );
  }
  const onlyOrg = [...orgs][0];
  trace.push(`[tenant] auto-selected organization_id=${onlyOrg}`);
  return { organization_id: onlyOrg, store_ids: [...stores], trace };
}

export function chunkIds(ids: string[], chunkSize = POSTGREST_IN_CHUNK_SIZE): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    out.push(ids.slice(i, i + chunkSize));
  }
  return out;
}

/** Authoritative product snapshot — projected from public.products. */
export type ProductSnapshot = {
  product_id: string;
  found: boolean;
  organization_id?: string | null;
  store_id?: string | null;
  sku?: string | null;
  product_name?: string | null;
  asin?: string | null;
  fnsku?: string | null;
  upc_code?: string | null;
  mfg_part_number?: string | null;
  barcode?: string | null;
  brand?: string | null;
  vendor_name?: string | null;
  condition?: string | null;
  status?: string | null;
  merge_status?: string | null;
  merged_into_id?: string | null;
  deleted_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_seen_at?: string | null;
  last_catalog_sync_at?: string | null;
  last_price_updated_at?: string | null;
  main_image_url?: string | null;
  image_url?: string | null;
};

export type IdentifierMapSnapshot = {
  id: string;
  product_id: string;
  seller_sku: string | null;
  asin: string | null;
  fnsku: string | null;
  upc_code: string | null;
  store_id: string | null;
  msku: string | null;
  title: string | null;
  source_report_type: string | null;
  match_source: string | null;
  is_primary: boolean | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
};

export type ComputedSignals = {
  n_distinct_titles: number;
  n_distinct_skus: number;
  n_distinct_asins: number;
  n_distinct_fnskus: number;
  n_distinct_upcs: number;
  any_merged: boolean;
  any_deleted: boolean;
  any_cross_store: boolean;
  any_missing: boolean;
  merged_into_inside_cluster: boolean;
  title_similarity_max: number | null;
  likely_same_product_hint: LikelyHint;
  likely_same_product_reasons: string[];
};

export type EnrichedProductEntry = {
  product_id: string;
  found: boolean;
  snapshot: ProductSnapshot | null;
  identifier_map_rows: IdentifierMapSnapshot[];
};

export type EnrichedCluster = ClusterInput & {
  enrichment: {
    products: EnrichedProductEntry[];
    computed: ComputedSignals;
  };
};

export type BuildEnrichedClusterArgs = {
  cluster: ClusterInput;
  productsById: Map<string, ProductSnapshot>;
  identifierMapByProductId: Map<string, IdentifierMapSnapshot[]>;
};

export function buildEnrichedCluster(args: BuildEnrichedClusterArgs): EnrichedCluster {
  const { cluster, productsById, identifierMapByProductId } = args;
  const entries: EnrichedProductEntry[] = cluster.conflicting_product_ids.map((pid) => {
    const snapshot = productsById.get(pid) ?? null;
    const mapRows = identifierMapByProductId.get(pid) ?? [];
    return {
      product_id: pid,
      found: snapshot != null && snapshot.found === true,
      snapshot,
      identifier_map_rows: mapRows,
    };
  });
  const computed = computeSignals(entries, cluster);
  return {
    ...cluster,
    enrichment: { products: entries, computed },
  };
}

function computeSignals(
  entries: EnrichedProductEntry[],
  cluster: ClusterInput,
): ComputedSignals {
  const titles = new Set<string>();
  const skus = new Set<string>();
  const asins = new Set<string>();
  const fnskus = new Set<string>();
  const upcs = new Set<string>();
  const stores = new Set<string>();
  let anyMerged = false;
  let anyDeleted = false;
  let anyMissing = false;
  let mergedIntoInsideCluster = false;
  const pidSet = new Set(cluster.conflicting_product_ids);
  const titleList: string[] = [];

  for (const e of entries) {
    if (!e.found || !e.snapshot) {
      anyMissing = true;
      continue;
    }
    const s = e.snapshot;
    const title = nonEmpty(s.product_name);
    if (title) {
      titles.add(title.toLowerCase());
      titleList.push(title);
    }
    if (nonEmpty(s.sku)) skus.add((s.sku as string).toLowerCase());
    if (nonEmpty(s.asin)) asins.add((s.asin as string).toUpperCase());
    if (nonEmpty(s.fnsku)) fnskus.add((s.fnsku as string).toUpperCase());
    if (nonEmpty(s.upc_code)) upcs.add(s.upc_code as string);
    if (nonEmpty(s.store_id)) stores.add(s.store_id as string);
    if (s.merge_status === "merged" || s.merge_status === "duplicate") anyMerged = true;
    if (s.deleted_at) anyDeleted = true;
    if (nonEmpty(s.merged_into_id) && pidSet.has(s.merged_into_id as string)) {
      mergedIntoInsideCluster = true;
    }
  }

  const title_similarity_max = titleList.length >= 2 ? maxPairwiseTitleSimilarity(titleList) : null;

  const hint = computeLikelySameProductHint({
    n_pids: cluster.conflicting_product_ids.length,
    n_distinct_titles: titles.size,
    n_distinct_skus: skus.size,
    n_distinct_asins: asins.size,
    n_distinct_fnskus: fnskus.size,
    n_distinct_upcs: upcs.size,
    any_merged: anyMerged,
    any_deleted: anyDeleted,
    any_cross_store: stores.size >= 2,
    any_missing: anyMissing,
    merged_into_inside_cluster: mergedIntoInsideCluster,
    title_similarity_max,
  });

  return {
    n_distinct_titles: titles.size,
    n_distinct_skus: skus.size,
    n_distinct_asins: asins.size,
    n_distinct_fnskus: fnskus.size,
    n_distinct_upcs: upcs.size,
    any_merged: anyMerged,
    any_deleted: anyDeleted,
    any_cross_store: stores.size >= 2,
    any_missing: anyMissing,
    merged_into_inside_cluster: mergedIntoInsideCluster,
    title_similarity_max,
    likely_same_product_hint: hint.hint,
    likely_same_product_reasons: hint.reasons,
  };
}

export type ComputeLikelyHintArgs = {
  n_pids: number;
  n_distinct_titles: number;
  n_distinct_skus: number;
  n_distinct_asins: number;
  n_distinct_fnskus: number;
  n_distinct_upcs: number;
  any_merged: boolean;
  any_deleted: boolean;
  any_cross_store: boolean;
  any_missing: boolean;
  merged_into_inside_cluster: boolean;
  title_similarity_max: number | null;
};

/**
 * Deterministic hint heuristic. NEVER reaches yes_high from title similarity
 * alone — at least one strong identifier signal (single sku/asin) or an
 * existing PIM merge decision is required.
 */
export function computeLikelySameProductHint(
  args: ComputeLikelyHintArgs,
): { hint: LikelyHint; reasons: string[] } {
  const reasons: string[] = [];

  if (args.merged_into_inside_cluster) {
    reasons.push("existing_merge_decision");
    if (args.any_cross_store) reasons.push("cross_store_caveat");
    return { hint: "yes_high", reasons };
  }

  if (args.any_cross_store) {
    reasons.push("cross_store_split");
    if (args.n_distinct_asins === 1) reasons.push("single_asin");
    if (args.n_distinct_fnskus === 1) reasons.push("single_fnsku");
    if (args.n_distinct_skus === 1) reasons.push("single_sku");
    return { hint: "uncertain", reasons };
  }

  if (args.any_missing) {
    reasons.push("missing_product_row");
  }

  const singleSku = args.n_distinct_skus === 1;
  const singleAsin = args.n_distinct_asins === 1;
  const singleFnsku = args.n_distinct_fnskus === 1;
  const singleTitle = args.n_distinct_titles === 1;
  const sim = args.title_similarity_max ?? 0;

  if (args.any_merged && singleSku) {
    reasons.push("existing_duplicate_flag", "single_sku");
    if (singleAsin) reasons.push("single_asin");
    return { hint: "yes_high", reasons };
  }

  if (singleSku && singleAsin) {
    reasons.push("single_sku", "single_asin");
    if (singleFnsku) reasons.push("single_fnsku");
    if (singleTitle) reasons.push("single_title");
    return { hint: "yes_high", reasons };
  }

  if (singleAsin && (sim >= 0.5 || singleTitle)) {
    reasons.push("single_asin");
    if (singleTitle) reasons.push("single_title");
    if (sim >= 0.5) reasons.push(`title_similarity_${sim.toFixed(2)}`);
    return { hint: "yes_medium", reasons };
  }

  if (args.any_merged) {
    reasons.push("existing_duplicate_flag");
    return { hint: "yes_medium", reasons };
  }

  const allDistinct =
    args.n_distinct_skus === args.n_pids &&
    args.n_distinct_asins === args.n_pids &&
    args.n_distinct_fnskus === args.n_pids;
  if (allDistinct && sim < 0.2) {
    reasons.push("all_distinct_identifiers", `title_similarity_${sim.toFixed(2)}`);
    return { hint: "no_low", reasons };
  }

  reasons.push("insufficient_evidence");
  if (sim > 0) reasons.push(`title_similarity_${sim.toFixed(2)}`);
  return { hint: "uncertain", reasons };
}

export function titleSimilarity3Gram(a: string, b: string): number {
  const ga = tokenTrigrams(a);
  const gb = tokenTrigrams(b);
  if (ga.size === 0 && gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function tokenTrigrams(s: string): Set<string> {
  const out = new Set<string>();
  const norm = s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = norm.split(" ").filter((t) => t.length > 0);
  if (tokens.length === 0) return out;
  if (tokens.length < 3) {
    out.add(tokens.join(" "));
    return out;
  }
  for (let i = 0; i + 3 <= tokens.length; i++) {
    out.add(tokens.slice(i, i + 3).join(" "));
  }
  return out;
}

function maxPairwiseTitleSimilarity(titles: string[]): number {
  let max = 0;
  for (let i = 0; i < titles.length; i++) {
    for (let j = i + 1; j < titles.length; j++) {
      const s = titleSimilarity3Gram(titles[i], titles[j]);
      if (s > max) max = s;
    }
  }
  return max;
}

function nonEmpty(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

export const __testables = { tokenTrigrams, maxPairwiseTitleSimilarity };
