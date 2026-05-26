/**
 * AMAZON-REMOVALS-SOURCE-REINGEST-PLAN-V194B — dry-run repoint plan (read-only).
 *
 * Tier policy:
 *   - Auto-repoint proposals: order_id+sku (and order_id+fnsku / staging_line) with exactly one live row
 *   - Manual review queue: ambiguous order_id+sku clusters, SKU-only tiers (never auto-repoint)
 *   - Optional import re-ingest track: no order_id hint and no alternate match
 *
 *   npx tsx scripts/amazon-removals-source-reingest-plan-v194b-staging.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { fetchCandidateSourceContextMap } from "../lib/claim-artifact-projection-core";
import {
  mergeOperationalHints,
  resolveAmazonRemovalsOperationalRow,
} from "../lib/claim-operational-source-resolve";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/amazon-removals-source-reingest-plan-v194b";
const V193B_RUN = "20260525T210000Z";

type Tier =
  | "order_id_sku_deterministic"
  | "order_id_sku_ambiguous"
  | "order_id_fnsku_deterministic"
  | "order_id_fnsku_ambiguous"
  | "staging_line_deterministic"
  | "staging_line_ambiguous"
  | "sku_only_deterministic_manual"
  | "sku_only_ambiguous_cluster"
  | "wrong_table_shipment_needs_order_tier"
  | "import_reingest"
  | "already_linked"
  | "unclassified";

type RepointProposal = {
  claim_candidate_id: string;
  organization_id: string;
  store_id: string | null;
  old_source_row_id: string;
  proposed_source_row_id: string | null;
  tier: Tier;
  matched_via: string;
  hint_order_id: string | null;
  hint_sku: string | null;
  hint_fnsku: string | null;
  match_count: number;
  auto_repoint_eligible: boolean;
  stale_id_is_shipment: boolean;
  recommended_action: string;
  candidate_removal_ids: string[];
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function tierCounts(proposals: RepointProposal[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of proposals) out[p.tier] = (out[p.tier] ?? 0) + 1;
  return out;
}

function writeRollbackSql(outDir: string, proposals: RepointProposal[]): void {
  const auto = proposals.filter((p) => p.auto_repoint_eligible && p.proposed_source_row_id);
  const lines = [
    "-- V194B execute rollback: restore claim_candidates.source_row_id from preimage",
    "-- Apply only after governed execute run; not for plan dry-run.",
    "BEGIN;",
  ];
  for (const p of auto) {
    lines.push(
      `UPDATE public.claim_candidates SET source_row_id = '${p.old_source_row_id}'::uuid, updated_at = now() WHERE id = '${p.claim_candidate_id}'::uuid;`,
    );
  }
  lines.push("COMMIT;");
  fs.writeFileSync(path.join(outDir, "rollback.sql"), lines.join("\n"), "utf8");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging guard failed (ref=${ref})`);
  }

  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const supabase = createClient(publicUrl, key, { auth: { persistSession: false } });
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const classified = await client.query(`
    WITH broken AS (
      SELECT
        c.id,
        c.organization_id,
        c.store_id,
        c.source_row_id,
        c.sku,
        c.fnsku,
        c.asin
      FROM public.claim_candidates c
      WHERE c.source_table = 'amazon_removals'
        AND c.resolved_product_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.amazon_removals r
          WHERE r.id = c.source_row_id AND r.organization_id = c.organization_id
        )
    ),
    with_hints AS (
      SELECT
        b.*,
        COALESCE(
          NULLIF(trim(ctx.source_order_id::text), ''),
          NULLIF(trim(sh.order_id::text), '')
        ) AS hint_order_id,
        COALESCE(
          NULLIF(trim(b.sku::text), ''),
          NULLIF(trim(ctx.source_sku::text), ''),
          NULLIF(trim(ctx.candidate_sku::text), '')
        ) AS hint_sku,
        COALESCE(
          NULLIF(trim(b.fnsku::text), ''),
          NULLIF(trim(ctx.candidate_fnsku::text), '')
        ) AS hint_fnsku,
        (sh.id IS NOT NULL) AS stale_id_is_shipment,
        sh.order_id AS shipment_order_id
      FROM broken b
      LEFT JOIN public.v_claim_candidate_source_context ctx ON ctx.claim_candidate_id = b.id
      LEFT JOIN public.amazon_removal_shipments sh
        ON sh.id = b.source_row_id AND sh.organization_id = b.organization_id
    ),
    order_sku AS (
      SELECT wh.id AS candidate_id, array_agg(r.id ORDER BY r.id) AS removal_ids, COUNT(*)::int AS n
      FROM with_hints wh
      INNER JOIN public.amazon_removals r
        ON r.organization_id = wh.organization_id
       AND r.order_id = wh.hint_order_id
       AND r.sku IS NOT DISTINCT FROM wh.hint_sku
      WHERE wh.hint_order_id IS NOT NULL AND wh.hint_sku IS NOT NULL
      GROUP BY wh.id
    ),
    sku_only AS (
      SELECT wh.id AS candidate_id, array_agg(r.id ORDER BY r.id) AS removal_ids, COUNT(*)::int AS n
      FROM with_hints wh
      INNER JOIN public.amazon_removals r
        ON r.organization_id = wh.organization_id
       AND r.sku IS NOT DISTINCT FROM wh.hint_sku
      WHERE wh.hint_order_id IS NULL AND wh.hint_sku IS NOT NULL
      GROUP BY wh.id
    ),
    sku_single_order AS (
      SELECT
        so.candidate_id,
        r.order_id AS derived_order_id,
        r.id AS single_removal_id
      FROM sku_only so
      INNER JOIN public.amazon_removals r ON r.id = so.removal_ids[1]
      WHERE so.n = 1 AND r.order_id IS NOT NULL
    ),
    sku_derived_order_sku AS (
      SELECT
        sso.candidate_id,
        array_agg(r.id ORDER BY r.id) AS removal_ids,
        COUNT(*)::int AS n
      FROM sku_single_order sso
      INNER JOIN public.amazon_removals r
        ON r.organization_id = (
          SELECT organization_id FROM with_hints wh WHERE wh.id = sso.candidate_id
        )
       AND r.order_id = sso.derived_order_id
       AND r.sku IS NOT DISTINCT FROM (
          SELECT hint_sku FROM with_hints wh WHERE wh.id = sso.candidate_id
        )
      GROUP BY sso.candidate_id
    )
    SELECT
      wh.id::text AS claim_candidate_id,
      wh.organization_id::text AS organization_id,
      wh.store_id::text AS store_id,
      wh.source_row_id::text AS old_source_row_id,
      wh.hint_order_id,
      wh.hint_sku,
      wh.hint_fnsku,
      wh.stale_id_is_shipment,
      wh.shipment_order_id,
      COALESCE(os.n, 0) AS order_sku_match_count,
      os.removal_ids AS order_sku_removal_ids,
      COALESCE(so.n, 0) AS sku_only_match_count,
      so.removal_ids AS sku_only_removal_ids,
      sdos.derived_order_id,
      COALESCE(sdos2.n, 0) AS derived_order_sku_match_count,
      sdos2.removal_ids AS derived_order_sku_removal_ids
    FROM with_hints wh
    LEFT JOIN order_sku os ON os.candidate_id = wh.id
    LEFT JOIN sku_only so ON so.candidate_id = wh.id
    LEFT JOIN sku_single_order sdos ON sdos.candidate_id = wh.id
    LEFT JOIN sku_derived_order_sku sdos2 ON sdos2.candidate_id = wh.id
    ORDER BY wh.id
  `);

  const proposals: RepointProposal[] = [];
  const pendingResolverIds: string[] = [];
  const rowByCandidateId = new Map<string, Record<string, unknown>>();

  for (const row of classified.rows as Array<Record<string, unknown>>) {
    rowByCandidateId.set(String(row.claim_candidate_id), row);
    const orderSkuN = Number(row.order_sku_match_count ?? 0);
    const derivedOrderSkuN = Number(row.derived_order_sku_match_count ?? 0);
    const skuOnlyN = Number(row.sku_only_match_count ?? 0);
    const staleShipment = row.stale_id_is_shipment === true;

    const pickIds = (v: unknown): string[] => {
      if (!Array.isArray(v)) return [];
      return v.map((x) => String(x));
    };

    let tier: Tier = "unclassified";
    let matchedVia = "none";
    let matchCount = 0;
    let candidateRemovalIds: string[] = [];
    let proposed: string | null = null;
    let autoEligible = false;
    let action = "manual_review";

    if (orderSkuN === 1) {
      tier = "order_id_sku_deterministic";
      matchedVia = "order_id_sku";
      matchCount = 1;
      candidateRemovalIds = pickIds(row.order_sku_removal_ids);
      proposed = candidateRemovalIds[0] ?? null;
      autoEligible = true;
      action = "governed_repoint_source_row_id";
    } else if (orderSkuN > 1) {
      tier = "order_id_sku_ambiguous";
      matchedVia = "order_id_sku";
      matchCount = orderSkuN;
      candidateRemovalIds = pickIds(row.order_sku_removal_ids);
      action = "manual_review_ambiguous_order_id_sku_cluster";
    } else if (derivedOrderSkuN === 1) {
      tier = "order_id_sku_deterministic";
      matchedVia = "order_id_sku_derived_from_single_sku_match";
      matchCount = 1;
      candidateRemovalIds = pickIds(row.derived_order_sku_removal_ids);
      proposed = candidateRemovalIds[0] ?? null;
      autoEligible = true;
      action = "governed_repoint_source_row_id";
    } else if (derivedOrderSkuN > 1) {
      tier = "order_id_sku_ambiguous";
      matchedVia = "order_id_sku_derived_from_single_sku_match";
      matchCount = derivedOrderSkuN;
      candidateRemovalIds = pickIds(row.derived_order_sku_removal_ids);
      action = "manual_review_ambiguous_order_id_sku_cluster";
    } else if (skuOnlyN === 1) {
      tier = "sku_only_deterministic_manual";
      matchedVia = "sku_only";
      matchCount = 1;
      candidateRemovalIds = pickIds(row.sku_only_removal_ids);
      proposed = candidateRemovalIds[0] ?? null;
      autoEligible = false;
      action = "manual_review_sku_only_not_auto_repoint";
    } else if (skuOnlyN > 1) {
      tier = "sku_only_ambiguous_cluster";
      matchedVia = "sku_only";
      matchCount = skuOnlyN;
      candidateRemovalIds = pickIds(row.sku_only_removal_ids);
      action = "manual_review_ambiguous_sku_cluster";
    } else {
      pendingResolverIds.push(String(row.claim_candidate_id));
      tier = "import_reingest";
      matchedVia = "pending_resolver";
      action = staleShipment
        ? "resolver_pass_shipment_or_reingest"
        : "resolver_pass_order_id_fnsku_staging_or_reingest";
    }

    proposals.push({
      claim_candidate_id: String(row.claim_candidate_id),
      organization_id: String(row.organization_id),
      store_id: row.store_id != null ? String(row.store_id) : null,
      old_source_row_id: String(row.old_source_row_id),
      proposed_source_row_id: proposed,
      tier,
      matched_via: matchedVia,
      hint_order_id:
        row.hint_order_id != null
          ? String(row.hint_order_id)
          : row.derived_order_id != null
            ? String(row.derived_order_id)
            : null,
      hint_sku: row.hint_sku != null ? String(row.hint_sku) : null,
      hint_fnsku: row.hint_fnsku != null ? String(row.hint_fnsku) : null,
      match_count: matchCount,
      auto_repoint_eligible: autoEligible,
      stale_id_is_shipment: staleShipment,
      recommended_action: action,
      candidate_removal_ids: candidateRemovalIds.slice(0, 8),
    });
  }

  const resolverStats = {
    order_id_fnsku_deterministic: 0,
    order_id_fnsku_ambiguous: 0,
    staging_line_deterministic: 0,
    staging_line_ambiguous: 0,
    import_reingest: 0,
    wrong_table_shipment_needs_order_tier: 0,
  };
  const CHUNK = 80;
  for (let i = 0; i < pendingResolverIds.length; i += CHUNK) {
    const slice = pendingResolverIds.slice(i, i + CHUNK);
    const candRes = await client.query(
      `SELECT id::text, organization_id::text, store_id::text, source_row_id::text, sku, fnsku, asin
       FROM public.claim_candidates WHERE id = ANY($1::uuid[])`,
      [slice],
    );
    const ctxMap = await fetchCandidateSourceContextMap(supabase, slice);
    for (const cand of candRes.rows as Record<string, unknown>[]) {
      const id = String(cand.id);
      const hints = mergeOperationalHints(cand, ctxMap.get(id) ?? null);
      const alt = await resolveAmazonRemovalsOperationalRow(
        supabase,
        String(cand.organization_id),
        cand.store_id != null ? String(cand.store_id) : null,
        String(cand.source_row_id),
        hints,
      );
      const plan = proposals.find((p) => p.claim_candidate_id === id);
      if (!plan) continue;
      const baseRow = rowByCandidateId.get(id);

      if (alt.row && !alt.ambiguous) {
        plan.proposed_source_row_id = String(alt.row.id);
        plan.match_count = 1;
        plan.auto_repoint_eligible = true;
        plan.candidate_removal_ids = [String(alt.row.id)];
        plan.recommended_action = "governed_repoint_source_row_id";
        if (alt.matched_via === "order_id_fnsku") {
          plan.tier = "order_id_fnsku_deterministic";
          resolverStats.order_id_fnsku_deterministic++;
        } else if (alt.matched_via === "staging_line") {
          plan.tier = "staging_line_deterministic";
          resolverStats.staging_line_deterministic++;
        } else {
          plan.tier = "order_id_sku_deterministic";
        }
        plan.matched_via = alt.matched_via;
      } else if (alt.ambiguous) {
        plan.auto_repoint_eligible = false;
        plan.match_count = alt.match_count;
        plan.recommended_action = `manual_review_resolver_${alt.matched_via}`;
        if (alt.matched_via === "order_id_fnsku") {
          plan.tier = "order_id_fnsku_ambiguous";
          resolverStats.order_id_fnsku_ambiguous++;
        } else if (alt.matched_via === "staging_line") {
          plan.tier = "staging_line_ambiguous";
          resolverStats.staging_line_ambiguous++;
        } else {
          plan.tier = "order_id_sku_ambiguous";
        }
        plan.matched_via = alt.matched_via;
      } else if (baseRow?.stale_id_is_shipment && baseRow.shipment_order_id != null && !hints.order_id) {
        plan.tier = "wrong_table_shipment_needs_order_tier";
        plan.matched_via = "shipment_stale_id";
        plan.recommended_action = "derive_order_id_from_shipment_then_retry_order_id_sku";
        resolverStats.wrong_table_shipment_needs_order_tier++;
      } else {
        plan.tier = "import_reingest";
        plan.matched_via = "none";
        plan.recommended_action = plan.stale_id_is_shipment
          ? "optional_import_reingest_or_fix_source_table"
          : "optional_import_reingest";
        resolverStats.import_reingest++;
      }
    }
  }

  const manualReviewQueue: Array<Record<string, unknown>> = [];
  const clusterMap = new Map<string, { tier: string; organization_id: string; hint_order_id: string | null; hint_sku: string | null; hint_fnsku: string | null; candidate_ids: string[]; match_count: number }>();

  for (const p of proposals) {
    if (
      p.tier === "order_id_sku_ambiguous" ||
      p.tier === "order_id_fnsku_ambiguous" ||
      p.tier === "staging_line_ambiguous" ||
      p.tier === "sku_only_ambiguous_cluster" ||
      p.tier === "sku_only_deterministic_manual"
    ) {
      const key = [p.organization_id, p.tier, p.hint_order_id ?? "", p.hint_sku ?? "", p.hint_fnsku ?? ""].join("\0");
      const existing = clusterMap.get(key);
      if (existing) existing.candidate_ids.push(p.claim_candidate_id);
      else {
        clusterMap.set(key, {
          tier: p.tier,
          organization_id: p.organization_id,
          hint_order_id: p.hint_order_id,
          hint_sku: p.hint_sku,
          hint_fnsku: p.hint_fnsku,
          candidate_ids: [p.claim_candidate_id],
          match_count: p.match_count,
        });
      }
    }
  }
  for (const [, cluster] of clusterMap) {
    manualReviewQueue.push({
      ...cluster,
      candidate_count: cluster.candidate_ids.length,
      queue_reason:
        cluster.tier === "sku_only_deterministic_manual"
          ? "SKU-only single match — excluded from auto-repoint policy"
          : "ambiguous match cluster — operator must pick removal row",
      sample_candidate_ids: cluster.candidate_ids.slice(0, 12),
    });
  }
  manualReviewQueue.sort((a, b) => Number(b.candidate_count) - Number(a.candidate_count));

  const reingestCandidates = proposals.filter(
    (p) => p.tier === "import_reingest" || p.tier === "wrong_table_shipment_needs_order_tier",
  );

  const uploadReingestHint = await client.query(`
    WITH broken AS (
      SELECT c.id, c.organization_id, c.sku
      FROM public.claim_candidates c
      WHERE c.source_table = 'amazon_removals'
        AND c.resolved_product_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.amazon_removals r
          WHERE r.id = c.source_row_id AND r.organization_id = c.organization_id
        )
    )
    SELECT
      r.upload_id::text AS upload_id,
      COUNT(DISTINCT b.id)::bigint AS broken_candidates
    FROM broken b
    INNER JOIN public.amazon_removals r
      ON r.organization_id = b.organization_id AND r.sku IS NOT DISTINCT FROM b.sku
    WHERE r.upload_id IS NOT NULL
    GROUP BY r.upload_id
    ORDER BY broken_candidates DESC
    LIMIT 25
  `);

  const resolverCrossCheck: Record<string, number> = { agree: 0, disagree: 0, resolver_ambiguous: 0, resolver_no_match: 0 };
  const crossCheckSamples: Array<Record<string, unknown>> = [];
  const sampleIds = proposals
    .filter((p) => p.auto_repoint_eligible)
    .slice(0, 40)
    .map((p) => p.claim_candidate_id);
  if (sampleIds.length > 0) {
    const candRes = await client.query(
      `SELECT id::text, organization_id::text, store_id::text, source_row_id::text, sku, fnsku, asin
       FROM public.claim_candidates WHERE id = ANY($1::uuid[])`,
      [sampleIds],
    );
    const ctxMap = await fetchCandidateSourceContextMap(
      supabase,
      sampleIds,
    );
    for (const row of candRes.rows as Record<string, unknown>[]) {
      const id = String(row.id);
      const hints = mergeOperationalHints(row, ctxMap.get(id) ?? null);
      const alt = await resolveAmazonRemovalsOperationalRow(
        supabase,
        String(row.organization_id),
        row.store_id != null ? String(row.store_id) : null,
        String(row.source_row_id),
        hints,
      );
      const plan = proposals.find((p) => p.claim_candidate_id === id);
      if (!plan) continue;
      if (alt.row && !alt.ambiguous && plan.proposed_source_row_id === String(alt.row.id)) {
        resolverCrossCheck.agree++;
      } else if (alt.ambiguous) {
        resolverCrossCheck.resolver_ambiguous++;
      } else if (!alt.row) {
        resolverCrossCheck.resolver_no_match++;
      } else {
        resolverCrossCheck.disagree++;
      }
      if (crossCheckSamples.length < 15) {
        crossCheckSamples.push({
          claim_candidate_id: id,
          plan_tier: plan.tier,
          plan_proposed: plan.proposed_source_row_id,
          resolver_matched_via: alt.matched_via,
          resolver_proposed: alt.row ? String(alt.row.id) : null,
          resolver_ambiguous: alt.ambiguous,
        });
      }
    }
  }

  await client.end();

  const counts = tierCounts(proposals);
  const autoRepoint = proposals.filter((p) => p.auto_repoint_eligible);
  const preimage = autoRepoint.map((p) => ({
    claim_candidate_id: p.claim_candidate_id,
    old_source_row_id: p.old_source_row_id,
    proposed_source_row_id: p.proposed_source_row_id,
    tier: p.tier,
    matched_via: p.matched_via,
  }));

  writeRollbackSql(outDir, proposals);

  const manifest = {
    prompt: "AMAZON-REMOVALS-SOURCE-REINGEST-PLAN-V194B",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "dry_run_plan_only",
    v193b_prerequisite_run: V193B_RUN,
    resolver_pass_stats: resolverStats,
    broken_candidates: proposals.length,
    tier_counts: counts,
    auto_repoint_eligible: autoRepoint.length,
    manual_review_queue_clusters: manualReviewQueue.length,
    manual_review_candidates:
      (counts.order_id_sku_ambiguous ?? 0) +
      (counts.order_id_fnsku_ambiguous ?? 0) +
      (counts.staging_line_ambiguous ?? 0) +
      (counts.sku_only_ambiguous_cluster ?? 0) +
      (counts.sku_only_deterministic_manual ?? 0),
    import_reingest_candidates: reingestCandidates.length,
    sku_only_excluded_from_auto: (counts.sku_only_deterministic_manual ?? 0) + (counts.sku_only_ambiguous_cluster ?? 0),
    resolver_cross_check: resolverCrossCheck,
    execute_eligible: autoRepoint.length > 0,
    applied: 0,
    status: "PASS",
    next_prompt: "AMAZON-REMOVALS-SOURCE-REINGEST-EXECUTE-V194B",
    secondary_prompt: "optional: claim21 removal re-ingest dry-run per upload_id",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "tier-summary.json"), JSON.stringify(counts, null, 2));
  fs.writeFileSync(path.join(outDir, "repoint-plan.json"), JSON.stringify(proposals, null, 2));
  fs.writeFileSync(
    path.join(outDir, "deterministic-repoint-proposals.json"),
    JSON.stringify(autoRepoint, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "manual-review-queue.json"), JSON.stringify(manualReviewQueue, null, 2));
  fs.writeFileSync(
    path.join(outDir, "import-reingest-candidates.json"),
    JSON.stringify(reingestCandidates.slice(0, 500), null, 2),
  );
  fs.writeFileSync(path.join(outDir, "rollback-preimage.json"), JSON.stringify(preimage, null, 2));
  fs.writeFileSync(
    path.join(outDir, "resolver-cross-check.json"),
    JSON.stringify({ stats: resolverCrossCheck, samples: crossCheckSamples }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "reingest-plan.md"),
    [
      "# Optional import re-ingest track (V194B)",
      "",
      "Candidates with no order_id+sku match may require **Removal Order Detail** re-import rather than blind repoint.",
      "",
      "## Uploads with broken candidates (top 25)",
      "",
      ...uploadReingestHint.rows.map(
        (r: { upload_id: string; broken_candidates: string }) =>
          `- upload \`${r.upload_id}\`: **${r.broken_candidates}** broken candidates`,
      ),
      "",
      "## Suggested read-only follow-up",
      "",
      "```bash",
      "npx tsx scripts/claim21-removals-current-source-dryrun.ts --org-id=<uuid> --limit-removals=5000",
      "```",
      "",
      `Import-reingest candidate count (this plan): **${reingestCandidates.length}**`,
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# AMAZON-REMOVALS-SOURCE-REINGEST-PLAN-V194B",
      "",
      `- run_id: \`${runId}\``,
      `- mode: **dry-run plan only** (no claim table writes)`,
      "",
      "## Cohort",
      `- broken \`amazon_removals\` candidates: **${proposals.length}**`,
      "",
      "## Tier policy",
      "- **Auto-repoint:** `order_id+sku`, `order_id+fnsku`, `staging_line` with exactly one live row",
      "- **Manual review:** ambiguous clusters + all SKU-only tiers (never auto-repoint)",
      "- **Re-ingest:** no alternate match",
      "",
      "## Tier counts",
      ...Object.entries(counts).map(([k, v]) => `- \`${k}\`: **${v}**`),
      "",
      `- auto-repoint eligible: **${autoRepoint.length}**`,
      `- manual review clusters: **${manualReviewQueue.length}**`,
      `- import/re-ingest track: **${reingestCandidates.length}**`,
      "",
      "## Resolver cross-check (auto-repoint sample)",
      `- agree: **${resolverCrossCheck.agree}**`,
      `- disagree: **${resolverCrossCheck.disagree}**`,
      "",
      "Operator approval required before governed repoint execute.",
    ].join("\n"),
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
