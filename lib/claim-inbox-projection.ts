/**
 * NEXT-CLAIM-18 — Read-only Claim Inbox projection (server-side).
 *
 * Mirrors resolver bucket rules from scripts/claim-product-linkage-resolver-dry-run.ts
 * without writing audit files. SELECT-only helpers for API routes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CLAIM_SUPPORTED_SOURCE_TABLES,
  type ClaimSourcePack,
  resolveClaimCandidateSourcePack,
} from "./claim-operational-source-resolve";
import {
  pickBestProductIdentifierMatch,
  type ProductIdentifierMapRow,
  type IdentifierLookupHints,
  type ProductIdentifierMatchResult,
} from "./product-identifier-match";

const SOURCE_FETCH_CHUNK = 120;
const PAGE = 400;
const PIM_OPEN_PAGE_MAX = 12_000;
const MAP_PREFETCH_CONCURRENCY = 12;

const TRUST_SOURCE_PRODUCT_ID = process.env.CLAIM_RESOLVER_TRUST_SOURCE_PRODUCT_ID === "true";

const MAP_SELECT =
  "id, organization_id, product_id, catalog_product_id, store_id, seller_sku, asin, fnsku, msku, upc_code, deleted_at, title";

export type ResolverFinalBucket =
  | "resolvable_from_source"
  | "resolvable_from_identifiers"
  | "ambiguous"
  | "missing_source_row"
  | "blocked_pim"
  | "unsupported_source_table"
  | "unresolved_no_identifiers"
  | "safe_update_candidate";

export type InboxQueue =
  | "legacy_source_broken"
  | "pim_blocked"
  | "evidence_missing"
  | "ready_for_review"
  | "needs_product_link";

type ProposalFrom = "source_resolved" | "source_product_id" | "identifier_map" | "none";

export type InboxProjectionRow = {
  final_bucket: ResolverFinalBucket;
  inbox_queue: InboxQueue;
  badges: string[];
  lineage_warning_code: string | null;
  automation_allowed: boolean;
  proposal_from: ProposalFrom;
  confidence: number;
  reason_codes: string[];
};

function n(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Exported string normalizer for API routes (same as internal `n`). */
export function claimInboxStr(v: unknown): string | null {
  return n(v);
}

const SUPPORTED_SOURCES = CLAIM_SUPPORTED_SOURCE_TABLES;

function mapLookupCacheKey(
  organizationId: string,
  storeId: string,
  hints: { fnsku?: string | null; msku?: string | null; asin?: string | null },
): string {
  return [organizationId, storeId, n(hints.fnsku) ?? "", n(hints.msku) ?? "", n(hints.asin) ?? ""].join("\x1f");
}

function extractIdentifierHints(source: Record<string, unknown> | null): IdentifierLookupHints & {
  raw: Record<string, string | null>;
} {
  const raw: Record<string, string | null> = {
    sku: n(source?.sku ?? source?.seller_sku),
    fnsku: n(source?.fnsku),
    asin: n(source?.asin),
    msku: n(source?.msku ?? source?.seller_sku ?? source?.sku),
    upc: n(source?.upc_code ?? source?.upc),
    lpn: n(source?.lpn),
    order_id: n(source?.order_id),
  };
  const organizationId = n(source?.organization_id) ?? "";
  const storeId = n(source?.store_id);
  return {
    organizationId,
    storeId,
    fnsku: raw.fnsku,
    msku: raw.sku ?? raw.msku,
    asin: raw.asin,
    raw,
  };
}

export function computeFinalBucket(args: {
  unsupported: boolean;
  missing: boolean;
  ambiguous: boolean;
  pimBlocked: boolean;
  proposedResolved: string | null;
  proposalFrom: ProposalFrom;
  evidenceStatus: string | null;
}): ResolverFinalBucket {
  if (args.unsupported) return "unsupported_source_table";
  if (args.missing) return "missing_source_row";
  if (args.ambiguous) return "ambiguous";
  if (args.pimBlocked && args.proposedResolved) return "blocked_pim";
  if (!args.proposedResolved) return "unresolved_no_identifiers";

  const evidenceOk = args.evidenceStatus !== "missing";

  if (args.proposalFrom === "identifier_map") {
    if (evidenceOk) return "safe_update_candidate";
    return "resolvable_from_identifiers";
  }
  if (args.proposalFrom === "source_resolved" || args.proposalFrom === "source_product_id") {
    if (evidenceOk) return "safe_update_candidate";
    return "resolvable_from_source";
  }
  return "unresolved_no_identifiers";
}

export function computeInboxQueueMeta(args: {
  finalBucket: ResolverFinalBucket;
  evidenceStatus: string | null;
  sourceTableRaw: string | null;
  sourceRowId: string | null;
  sourceFound: boolean;
  pack: ClaimSourcePack | undefined;
}): Pick<InboxProjectionRow, "inbox_queue" | "badges" | "lineage_warning_code" | "automation_allowed"> {
  const badges: string[] = [];
  if (args.finalBucket === "ambiguous") badges.push("conflict");

  const st = args.sourceTableRaw?.toLowerCase() ?? "";
  const p = args.pack;
  const noRowNoAlternate =
    !p?.row && !p?.id_lookup_hit && !p?.alternateTier && !p?.ambiguousOperational;

  const legacy =
    args.finalBucket === "missing_source_row" &&
    st === "amazon_removals" &&
    !!args.sourceRowId &&
    !args.sourceFound &&
    noRowNoAlternate;

  if (legacy) {
    return {
      inbox_queue: "legacy_source_broken",
      badges,
      lineage_warning_code: "stale_or_wrong_source_row_id",
      automation_allowed: false,
    };
  }
  if (args.finalBucket === "blocked_pim") {
    return { inbox_queue: "pim_blocked", badges, lineage_warning_code: null, automation_allowed: false };
  }
  if (args.finalBucket === "safe_update_candidate") {
    return { inbox_queue: "ready_for_review", badges, lineage_warning_code: null, automation_allowed: false };
  }
  if (args.finalBucket === "resolvable_from_source" || args.finalBucket === "resolvable_from_identifiers") {
    if (args.evidenceStatus === "missing") {
      return { inbox_queue: "evidence_missing", badges, lineage_warning_code: null, automation_allowed: false };
    }
    return { inbox_queue: "ready_for_review", badges, lineage_warning_code: null, automation_allowed: false };
  }
  return { inbox_queue: "needs_product_link", badges, lineage_warning_code: null, automation_allowed: false };
}

export async function fetchSourceRowsByIds(
  client: SupabaseClient,
  table: string,
  ids: string[],
  organizationScope: string | null,
): Promise<{ map: Map<string, Record<string, unknown>>; error: string | null }> {
  const map = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return { map, error: null };
  const scope = organizationScope?.trim() || null;
  for (let i = 0; i < ids.length; i += SOURCE_FETCH_CHUNK) {
    const slice = ids.slice(i, i + SOURCE_FETCH_CHUNK);
    let q = client.from(table).select("*").in("id", slice);
    if (scope) q = q.eq("organization_id", scope);
    const { data, error } = await q;
    if (error) return { map, error: error.message };
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const id = n(row.id);
      if (id) map.set(id, row);
    }
  }
  return { map, error: null };
}

export async function fetchCandidateSourceContextMap(
  client: SupabaseClient,
  candidateIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const m = new Map<string, Record<string, unknown>>();
  if (candidateIds.length === 0) return m;
  for (let i = 0; i < candidateIds.length; i += SOURCE_FETCH_CHUNK) {
    const slice = candidateIds.slice(i, i + SOURCE_FETCH_CHUNK);
    const { data, error } = await client
      .from("v_claim_candidate_source_context")
      .select("*")
      .in("claim_candidate_id", slice);
    if (error) continue;
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const cid = n(row.claim_candidate_id);
      if (cid) m.set(cid, row);
    }
  }
  return m;
}

export async function loadPimOpenMemberProductIds(client: SupabaseClient): Promise<Set<string>> {
  const set = new Set<string>();
  let from = 0;
  let totalRead = 0;
  for (;;) {
    const { data, error } = await client
      .from("pim_identifier_dispute")
      .select("id,members,status")
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break;
    const batch = (data ?? []) as { members?: unknown }[];
    for (const r of batch) {
      if (Array.isArray(r.members)) {
        for (const mem of r.members) {
          const s = n(mem);
          if (s) set.add(s);
        }
      }
    }
    totalRead += batch.length;
    if (batch.length < PAGE) break;
    from += PAGE;
    if (totalRead >= PIM_OPEN_PAGE_MAX) break;
  }
  return set;
}

async function fetchMapRowsForHints(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
  hints: { fnsku?: string | null; msku?: string | null; asin?: string | null },
): Promise<{ rows: ProductIdentifierMapRow[]; error: string | null }> {
  const sid = n(storeId);
  if (!sid) return { rows: [], error: null };

  const collected: ProductIdentifierMapRow[] = [];
  const seen = new Set<string>();
  const push = (data: unknown) => {
    for (const r of (data as Record<string, unknown>[]) ?? []) {
      const id = n(r.id);
      if (!id || seen.has(id)) continue;
      if (r.deleted_at != null) continue;
      seen.add(id);
      collected.push(r as unknown as ProductIdentifierMapRow);
    }
  };

  const fnsku = n(hints.fnsku);
  if (fnsku) {
    const { data, error } = await client
      .from("product_identifier_map")
      .select(MAP_SELECT)
      .eq("organization_id", organizationId)
      .eq("store_id", sid)
      .eq("fnsku", fnsku)
      .limit(120);
    if (error) return { rows: [], error: error.message };
    push(data);
  }
  const msku = n(hints.msku);
  if (msku) {
    const { data, error } = await client
      .from("product_identifier_map")
      .select(MAP_SELECT)
      .eq("organization_id", organizationId)
      .eq("store_id", sid)
      .eq("seller_sku", msku)
      .limit(200);
    if (error) return { rows: [], error: error.message };
    push(data);
    const { data: d2, error: e2 } = await client
      .from("product_identifier_map")
      .select(MAP_SELECT)
      .eq("organization_id", organizationId)
      .eq("store_id", sid)
      .eq("msku", msku)
      .limit(200);
    if (e2) return { rows: [], error: e2.message };
    push(d2);
  }
  const asin = n(hints.asin);
  if (asin) {
    const { data, error } = await client
      .from("product_identifier_map")
      .select(MAP_SELECT)
      .eq("organization_id", organizationId)
      .eq("store_id", sid)
      .eq("asin", asin)
      .limit(200);
    if (error) return { rows: [], error: error.message };
    push(data);
  }

  return { rows: collected, error: null };
}

async function prefetchMapRowsForPage(
  client: SupabaseClient,
  lookups: { key: string; organizationId: string; storeId: string; hints: { fnsku?: string | null; msku?: string | null; asin?: string | null } }[],
): Promise<Map<string, ProductIdentifierMapRow[]>> {
  const out = new Map<string, ProductIdentifierMapRow[]>();
  for (let i = 0; i < lookups.length; i += MAP_PREFETCH_CONCURRENCY) {
    const slice = lookups.slice(i, i + MAP_PREFETCH_CONCURRENCY);
    const chunk = await Promise.all(
      slice.map(async (e) => {
        const { rows, error } = await fetchMapRowsForHints(client, e.organizationId, e.storeId, e.hints);
        if (error) return { key: e.key, rows: [] as ProductIdentifierMapRow[] };
        return { key: e.key, rows };
      }),
    );
    for (const { key, rows } of chunk) out.set(key, rows);
  }
  return out;
}

export type ProjectedCandidate = InboxProjectionRow & {
  claim_candidate_id: string;
  source_found: boolean;
  proposed_resolved_product_id: string | null;
};

/**
 * Full resolver-aligned projection for a batch of claim_candidates (same org).
 */
export async function projectClaimCandidatesBatch(
  client: SupabaseClient,
  batch: Record<string, unknown>[],
  organizationId: string,
): Promise<Map<string, ProjectedCandidate>> {
  const out = new Map<string, ProjectedCandidate>();
  if (batch.length === 0) return out;

  const pimMembers = await loadPimOpenMemberProductIds(client);

  const byTable = new Map<string, string[]>();
  for (const c of batch) {
    const st = n(c.source_table)?.toLowerCase() ?? "";
    const sid = n(c.source_row_id);
    if (!st || !sid) continue;
    if (!SUPPORTED_SOURCES.has(st)) continue;
    if (!byTable.has(st)) byTable.set(st, []);
    byTable.get(st)!.push(sid);
  }

  const sourceMaps = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [tbl, ids] of byTable) {
    const uniq = [...new Set(ids)];
    const { map, error } = await fetchSourceRowsByIds(client, tbl, uniq, organizationId);
    if (error) continue;
    sourceMaps.set(tbl, map);
  }

  const candidateIds = batch.map((c) => n(c.id)).filter(Boolean) as string[];
  const contextByCandidateId = await fetchCandidateSourceContextMap(client, candidateIds);

  const sourcePackByCandidateId = new Map<string, Awaited<ReturnType<typeof resolveClaimCandidateSourcePack>>>();
  for (const c of batch) {
    const id = n(c.id) ?? "";
    const ctx = contextByCandidateId.get(id) ?? null;
    const pack = await resolveClaimCandidateSourcePack(client, c, sourceMaps, ctx);
    sourcePackByCandidateId.set(id, pack);
  }

  const mapPrefetchKeys = new Map<
    string,
    { organizationId: string; storeId: string; hints: { fnsku?: string | null; msku?: string | null; asin?: string | null } }
  >();
  for (const c of batch) {
    if (n(c.resolved_product_id)) continue;
    const orgId = n(c.organization_id) ?? "";
    const storeId = n(c.store_id);
    const sourceTable = n(c.source_table)?.toLowerCase() ?? "";
    const sourceRowId = n(c.source_row_id);
    if (!sourceTable || !sourceRowId || !SUPPORTED_SOURCES.has(sourceTable)) continue;
    const pack = sourcePackByCandidateId.get(n(c.id) ?? "") ?? {
      row: null,
      alternateTier: null,
      opReasonCodes: [],
      ambiguousOperational: false,
      id_lookup_hit: false,
    };
    const row = pack.row;
    if (!row) continue;
    if (n(row.resolved_product_id)) continue;
    if (TRUST_SOURCE_PRODUCT_ID && n(row.product_id)) continue;
    const hints = extractIdentifierHints(row);
    const effStore = storeId ?? n(row.store_id);
    if (!effStore) continue;
    const key = mapLookupCacheKey(orgId, effStore, {
      fnsku: hints.fnsku,
      msku: hints.msku,
      asin: hints.asin,
    });
    if (!mapPrefetchKeys.has(key)) {
      mapPrefetchKeys.set(key, {
        organizationId: orgId,
        storeId: effStore,
        hints: { fnsku: hints.fnsku, msku: hints.msku, asin: hints.asin },
      });
    }
  }
  const mapCache = await prefetchMapRowsForPage(
    client,
    [...mapPrefetchKeys.entries()].map(([key, v]) => ({ key, ...v })),
  );

  for (const c of batch) {
    const claimCandidateId = n(c.id) ?? "";
    const orgId = n(c.organization_id);
    const storeId = n(c.store_id);
    const sourceTableRaw = n(c.source_table);
    const sourceTable = sourceTableRaw?.toLowerCase() ?? "";
    const sourceRowId = n(c.source_row_id);
    const existingResolved = n(c.resolved_product_id);
    const evidenceStatus = n(c.evidence_status);

    let sourceFound = false;
    let sourceTier = "none";
    let proposedResolved: string | null = null;
    const reasonCodes: string[] = [];
    let mapMatch: ProductIdentifierMatchResult | null = null;
    let proposalFrom: ProposalFrom = "none";
    let ambiguous = false;

    if (existingResolved) {
      proposedResolved = existingResolved;
      sourceTier = "candidate_existing_resolved";
      proposalFrom = "source_resolved";
      sourceFound = true;
    } else if (!sourceTable || !sourceRowId) {
      reasonCodes.push("missing_source_pointer");
    } else if (!SUPPORTED_SOURCES.has(sourceTable)) {
      reasonCodes.push("unsupported_source_table");
    } else {
      const pack = sourcePackByCandidateId.get(claimCandidateId) ?? {
        row: null,
        alternateTier: null,
        opReasonCodes: [],
        ambiguousOperational: false,
        id_lookup_hit: false,
      };
      reasonCodes.push(...pack.opReasonCodes);
      if (pack.ambiguousOperational) ambiguous = true;

      const rowHit = pack.row;
      const alternateTier = pack.alternateTier;
      if (rowHit) {
        sourceFound = true;
        if (alternateTier) sourceTier = alternateTier;
        const rpid = n(rowHit.resolved_product_id);
        const pid = n(rowHit.product_id);
        if (rpid) {
          proposedResolved = rpid;
          sourceTier = "source_resolved_product_id";
          proposalFrom = "source_resolved";
        } else if (TRUST_SOURCE_PRODUCT_ID && pid) {
          proposedResolved = pid;
          sourceTier = "source_product_id_trusted";
          proposalFrom = "source_product_id";
          reasonCodes.push("used_product_id_under_env_trust");
        } else {
          const hints = extractIdentifierHints(rowHit);
          const effStore = storeId ?? n(rowHit.store_id);
          const mapKey =
            effStore != null ? mapLookupCacheKey(orgId ?? "", effStore, { fnsku: hints.fnsku, msku: hints.msku, asin: hints.asin }) : null;
          const mapRows = mapKey != null ? (mapCache.get(mapKey) ?? []) : [];
          if (!effStore) {
            reasonCodes.push("identifier_skipped_no_store_id");
          } else {
            const match = pickBestProductIdentifierMatch(mapRows, {
              organizationId: orgId ?? "",
              storeId: effStore,
              fnsku: hints.fnsku,
              msku: hints.msku,
              asin: hints.asin,
            });
            mapMatch = match;
            if (match.status === "resolved" && n(match.row?.product_id)) {
              proposedResolved = n(match.row!.product_id);
              sourceTier = "identifier_map";
              proposalFrom = "identifier_map";
            } else if (match.status === "ambiguous") {
              ambiguous = true;
              sourceTier = "identifier_map_ambiguous";
            }
          }
        }
      }
    }

    const pimBlocked = !!(proposedResolved && pimMembers.has(proposedResolved));
    const unsupported = !!(sourceTableRaw && !SUPPORTED_SOURCES.has(sourceTable));
    const missingPointer = !existingResolved && !unsupported && (!sourceTable || !sourceRowId);
    const missingRow =
      !unsupported &&
      !missingPointer &&
      !!sourceTable &&
      !!sourceRowId &&
      SUPPORTED_SOURCES.has(sourceTable) &&
      !sourceFound &&
      !existingResolved;
    const missing = missingPointer || missingRow;

    const finalBucket = computeFinalBucket({
      unsupported,
      missing,
      ambiguous,
      pimBlocked,
      proposedResolved,
      proposalFrom,
      evidenceStatus,
    });

    const meta = computeInboxQueueMeta({
      finalBucket,
      evidenceStatus,
      sourceTableRaw,
      sourceRowId,
      sourceFound,
      pack: sourcePackByCandidateId.get(claimCandidateId),
    });

    const confidence =
      mapMatch?.status === "resolved"
        ? mapMatch.confidence
        : sourceTier.startsWith("source_resolved")
          ? 0.98
          : proposedResolved
            ? 0.8
            : 0.15;

    out.set(claimCandidateId, {
      claim_candidate_id: claimCandidateId,
      final_bucket: finalBucket,
      inbox_queue: meta.inbox_queue,
      badges: meta.badges,
      lineage_warning_code: meta.lineage_warning_code,
      automation_allowed: meta.automation_allowed,
      proposal_from: proposalFrom,
      confidence,
      reason_codes: reasonCodes,
      source_found: sourceFound,
      proposed_resolved_product_id: proposedResolved,
    });
  }

  return out;
}
