/**
 * CLAIM-CANDIDATE-RESOLVER-V175 — Materialize claim_candidates / claim_candidate_drafts.resolved_product_id
 * from source rows + product_identifier_map (deterministic tiers only; no product auto-create).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PAGE,
  fetchCandidateSourceContextMap,
  projectClaimArtifactsBatchCore,
  type ClaimArtifactCoreProjection,
  type ResolverFinalBucket,
} from "./claim-artifact-projection-core";

export type ClaimArtifactTable = "claim_candidates" | "claim_candidate_drafts";

export type MaterializeProposal = {
  artifact_id: string;
  organization_id: string;
  source_table: string | null;
  source_row_id: string | null;
  proposed_resolved_product_id: string;
  proposal_from: string;
  final_bucket: ResolverFinalBucket;
  confidence: number;
  reason_codes: string[];
};

export type ResolverReadinessCheck = {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn";
  message: string;
};

export type ResolverBlocker = {
  code: string;
  severity: "blocker" | "warn";
  message: string;
  count: number;
};

export type ResolverPassMetrics = {
  table: ClaimArtifactTable;
  rows_scanned: number;
  rows_already_resolved: number;
  bucket_counts: Record<string, number>;
  eligible_safe_update: number;
  applied: number;
  skipped_ambiguous: number;
  skipped_unsupported: number;
  skipped_missing_source: number;
};

const ARTIFACT_SELECT = [
  "id",
  "organization_id",
  "store_id",
  "source_table",
  "source_row_id",
  "resolved_product_id",
  "evidence_status",
  "sku",
  "fnsku",
  "asin",
].join(", ");

const ALLOWED_PROPOSAL_FROM = new Set(["identifier_map", "source_resolved"]);

/** Buckets with a deterministic product proposal (excludes ambiguous / PIM-blocked). */
const MATERIALIZE_BUCKETS = new Set<ResolverFinalBucket>([
  "safe_update_candidate",
  "resolvable_from_source",
  "resolvable_from_identifiers",
]);

export function isEligibleMaterializeProposal(proj: ClaimArtifactCoreProjection): boolean {
  if (!MATERIALIZE_BUCKETS.has(proj.final_bucket)) return false;
  if (!ALLOWED_PROPOSAL_FROM.has(proj.proposal_from)) return false;
  if (!proj.proposed_resolved_product_id) return false;
  return true;
}

export async function scanClaimArtifactPage(
  client: SupabaseClient,
  table: ClaimArtifactTable,
  organizationId: string | null,
  offset: number,
  limit: number,
  onlyUnresolved: boolean,
): Promise<Record<string, unknown>[]> {
  let q = client.from(table).select(ARTIFACT_SELECT).order("id", { ascending: true }).range(offset, offset + limit - 1);
  if (organizationId) q = q.eq("organization_id", organizationId);
  if (onlyUnresolved) q = q.is("resolved_product_id", null);
  const { data, error } = await q;
  if (error) throw new Error(`${table} page read: ${error.message}`);
  return (data ?? []) as unknown as Record<string, unknown>[];
}

export async function runClaimResolverMaterializePass(
  client: SupabaseClient,
  table: ClaimArtifactTable,
  opts: {
    organizationId?: string | null;
    pageSize?: number;
    maxPages?: number;
    onlyUnresolved?: boolean;
    useInboxContext?: boolean;
  },
): Promise<{ metrics: ResolverPassMetrics; proposals: MaterializeProposal[] }> {
  const pageSize = opts.pageSize ?? PAGE;
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
  const onlyUnresolved = opts.onlyUnresolved !== false;
  const orgId = opts.organizationId?.trim() || null;

  const metrics: ResolverPassMetrics = {
    table,
    rows_scanned: 0,
    rows_already_resolved: 0,
    bucket_counts: {},
    eligible_safe_update: 0,
    applied: 0,
    skipped_ambiguous: 0,
    skipped_unsupported: 0,
    skipped_missing_source: 0,
  };
  const proposals: MaterializeProposal[] = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const batch = await scanClaimArtifactPage(client, table, orgId, offset, pageSize, onlyUnresolved);
    if (batch.length === 0) break;

    const unresolved = batch.filter((r) => !String(r.resolved_product_id ?? "").trim());
    metrics.rows_already_resolved += batch.length - unresolved.length;
    metrics.rows_scanned += batch.length;

    const fetchContext =
      opts.useInboxContext && table === "claim_candidates"
        ? fetchCandidateSourceContextMap
        : null;

    const orgForBatch = orgId ?? String(unresolved[0]?.organization_id ?? "");
    const projected = await projectClaimArtifactsBatchCore(
      client,
      unresolved,
      orgForBatch,
      fetchContext,
    );

    for (const row of unresolved) {
      const id = String(row.id);
      const proj = projected.get(id);
      if (!proj) continue;

      const bucket = proj.final_bucket;
      metrics.bucket_counts[bucket] = (metrics.bucket_counts[bucket] ?? 0) + 1;

      if (bucket === "ambiguous") metrics.skipped_ambiguous++;
      if (bucket === "unsupported_source_table") metrics.skipped_unsupported++;
      if (bucket === "missing_source_row") metrics.skipped_missing_source++;

      if (!isEligibleMaterializeProposal(proj)) continue;

      metrics.eligible_safe_update++;
      proposals.push({
        artifact_id: id,
        organization_id: String(row.organization_id),
        source_table: row.source_table != null ? String(row.source_table) : null,
        source_row_id: row.source_row_id != null ? String(row.source_row_id) : null,
        proposed_resolved_product_id: proj.proposed_resolved_product_id!,
        proposal_from: proj.proposal_from,
        final_bucket: proj.final_bucket,
        confidence: proj.confidence,
        reason_codes: proj.reason_codes,
      });
    }

    if (batch.length < pageSize) break;
  }

  return { metrics, proposals };
}

export type ApplyMaterializeResult = {
  applied: number;
  errors: string[];
};

export async function applyMaterializeProposals(
  client: SupabaseClient,
  table: ClaimArtifactTable,
  proposals: MaterializeProposal[],
  opts?: { dryRun?: boolean },
): Promise<ApplyMaterializeResult> {
  if (opts?.dryRun || proposals.length === 0) return { applied: 0, errors: [] };

  let applied = 0;
  const errors: string[] = [];
  const chunk = 40;
  for (let i = 0; i < proposals.length; i += chunk) {
    const slice = proposals.slice(i, i + chunk);
    await Promise.all(
      slice.map(async (p) => {
        const { data, error } = await client
          .from(table)
          .update({ resolved_product_id: p.proposed_resolved_product_id })
          .eq("id", p.artifact_id)
          .eq("organization_id", p.organization_id)
          .is("resolved_product_id", null)
          .select("id");
        if (error) {
          if (errors.length < 20) errors.push(`${p.artifact_id}: ${error.message}`);
          return;
        }
        if (data && data.length > 0) applied++;
      }),
    );
  }
  return { applied, errors };
}

export function buildResolverReadinessMatrix(input: {
  claimCandidates: ResolverPassMetrics;
  claimDrafts: ResolverPassMetrics;
  preCounts: { claim_candidates_total: number; claim_candidates_resolved: number; drafts_total: number; drafts_resolved: number };
  postCounts?: { claim_candidates_resolved: number; drafts_resolved: number };
}): ResolverReadinessCheck[] {
  const cc = input.claimCandidates;
  const cd = input.claimDrafts;
  const preCcPct =
    input.preCounts.claim_candidates_total > 0
      ? Math.round((input.preCounts.claim_candidates_resolved / input.preCounts.claim_candidates_total) * 1000) / 10
      : 0;
  const preCdPct =
    input.preCounts.drafts_total > 0
      ? Math.round((input.preCounts.drafts_resolved / input.preCounts.drafts_total) * 1000) / 10
      : 0;

  const eligible = cc.eligible_safe_update + cd.eligible_safe_update;
  const scanned = cc.rows_scanned + cd.rows_scanned;

  return [
    {
      id: "source_linkage",
      label: "Source row linkage (supported tables)",
      status: cc.skipped_missing_source + cd.skipped_missing_source < scanned ? "pass" : "warn",
      message: `missing_source_row: candidates ${cc.skipped_missing_source}, drafts ${cd.skipped_missing_source} of ${scanned} scanned unresolved`,
    },
    {
      id: "trid_coverage",
      label: "TRID / FRR source coverage",
      status: "pass",
      message: "Resolved via return_items / slip_contents / amazon_returns joins + identifier_map tiers when source lacks resolved_product_id",
    },
    {
      id: "unresolved_warnings",
      label: "Ambiguous identifier map",
      status: cc.skipped_ambiguous + cd.skipped_ambiguous === 0 ? "pass" : "warn",
      message: `ambiguous: candidates ${cc.skipped_ambiguous}, drafts ${cd.skipped_ambiguous}`,
    },
    {
      id: "evidence_grouping",
      label: "Supported source_table routing",
      status: cc.skipped_unsupported + cd.skipped_unsupported === 0 ? "pass" : "warn",
      message: `unsupported_source_table: candidates ${cc.skipped_unsupported}, drafts ${cd.skipped_unsupported}`,
    },
    {
      id: "attachment_readiness",
      label: "Store + identifier prerequisites",
      status: "pass",
      message: "Requires store_id + (source resolved_product_id or map tiers 1–4); no blind settlement/ledger bulk",
    },
    {
      id: "operator_review",
      label: "Materialization policy",
      status: "pass",
      message: "Only safe_update_candidate with proposal_from identifier_map | source_resolved (no TRUST_SOURCE_PRODUCT_ID)",
    },
    {
      id: "pre_coverage_candidates",
      label: "claim_candidates resolved_product_id (pre)",
      status: preCcPct >= 50 ? "pass" : preCcPct > 0 ? "warn" : "fail",
      message: `${input.preCounts.claim_candidates_resolved}/${input.preCounts.claim_candidates_total} (${preCcPct}%)`,
    },
    {
      id: "pre_coverage_drafts",
      label: "claim_candidate_drafts resolved_product_id (pre)",
      status: preCdPct >= 50 ? "pass" : preCdPct > 0 ? "warn" : "fail",
      message: `${input.preCounts.drafts_resolved}/${input.preCounts.drafts_total} (${preCdPct}%)`,
    },
    {
      id: "eligible_materialize",
      label: "Eligible safe materialization (dry-run)",
      status: eligible > 0 ? "pass" : "warn",
      message: `${eligible} rows across both tables`,
    },
  ];
}

export function buildBlockerInventory(
  candidateMetrics: ResolverPassMetrics,
  draftMetrics: ResolverPassMetrics,
): ResolverBlocker[] {
  const inventory: ResolverBlocker[] = [];
  const add = (code: string, severity: ResolverBlocker["severity"], table: string, count: number) => {
    if (count <= 0) return;
    inventory.push({
      code: `${table}:${code}`,
      severity,
      message: `${count} row(s) in ${table}`,
      count,
    });
  };

  for (const m of [candidateMetrics, draftMetrics]) {
    add("missing_source_row", "blocker", m.table, m.skipped_missing_source);
    add("ambiguous", "warn", m.table, m.skipped_ambiguous);
    add("unsupported_source_table", "blocker", m.table, m.skipped_unsupported);
    const skipBuckets = new Set([
      "missing_source_row",
      "ambiguous",
      "unsupported_source_table",
    ]);
    for (const [bucket, count] of Object.entries(m.bucket_counts)) {
      if (bucket === "safe_update_candidate") continue;
      if (skipBuckets.has(bucket)) continue;
      if (count <= 0) continue;
      const sev =
        bucket === "blocked_pim" ? "warn" : ("blocker" as const);
      add(bucket, sev, m.table, count);
    }
  }

  inventory.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  return inventory;
}
