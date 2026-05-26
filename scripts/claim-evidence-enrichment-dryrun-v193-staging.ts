/**
 * CLAIM-EVIDENCE-ENRICHMENT-DRYRUN-V193 — reference-edge / TRID enrichment dry-run (read-only).
 *
 *   npx tsx scripts/claim-evidence-enrichment-dryrun-v193-staging.ts --run-id=<id>
 *   npx tsx scripts/claim-evidence-enrichment-dryrun-v193-staging.ts --sample=250
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import type { ClaimEvidenceDraftRow } from "../lib/claim-evidence-preview";
import { loadAndBuildReferenceCandidatesForDraft } from "../lib/claim-reference-candidates";
import type { TridCandidateOutcome } from "../lib/claim-trid-candidates-types";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/claim-evidence-enrichment-dryrun-v193";
const V191_RUN = "20260525T190000Z";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function sampleArg(): number {
  const a = process.argv.find((x) => x.startsWith("--sample="));
  if (!a) return 200;
  const n = Number(a.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 200;
}

function toDraftRow(r: Record<string, unknown>): ClaimEvidenceDraftRow {
  return {
    id: String(r.id),
    organization_id: String(r.organization_id),
    store_id: r.store_id != null ? String(r.store_id) : null,
    source_table: String(r.source_table),
    source_row_id: String(r.source_row_id),
    sku: r.sku != null ? String(r.sku) : null,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const sampleSize = sampleArg();
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
  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const cohort = await pgClient.query(`
    SELECT COUNT(*)::bigint AS fk_ok_no_edges
    FROM public.claim_candidate_drafts d
    WHERE d.resolved_product_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = d.resolved_product_id)
      AND NOT EXISTS (SELECT 1 FROM public.claim_reference_edges e WHERE e.draft_id = d.id)
  `);

  const bySource = await pgClient.query(`
    SELECT d.source_table, COUNT(*)::bigint AS n
    FROM public.claim_candidate_drafts d
    WHERE d.resolved_product_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = d.resolved_product_id)
      AND NOT EXISTS (SELECT 1 FROM public.claim_reference_edges e WHERE e.draft_id = d.id)
    GROUP BY d.source_table ORDER BY n DESC
  `);

  const orderIdHeuristic = await pgClient.query(`
    SELECT
      COUNT(*) FILTER (WHERE d.source_table = 'amazon_returns' AND ar.id IS NOT NULL AND ar.order_id IS NOT NULL)::bigint AS returns_with_order,
      COUNT(*) FILTER (WHERE d.source_table = 'amazon_returns')::bigint AS returns_total,
      COUNT(*) FILTER (WHERE d.source_table = 'amazon_removals' AND rm.id IS NOT NULL AND rm.order_id IS NOT NULL)::bigint AS removals_with_order,
      COUNT(*) FILTER (WHERE d.source_table = 'amazon_removals')::bigint AS removals_total,
      COUNT(*) FILTER (WHERE d.source_table = 'amazon_removal_shipments' AND sh.id IS NOT NULL)::bigint AS shipments_source_ok
    FROM public.claim_candidate_drafts d
    LEFT JOIN public.amazon_returns ar ON d.source_table = 'amazon_returns' AND ar.id = d.source_row_id::uuid AND ar.organization_id = d.organization_id
    LEFT JOIN public.amazon_removals rm ON d.source_table = 'amazon_removals' AND rm.id = d.source_row_id::uuid AND rm.organization_id = d.organization_id
    LEFT JOIN public.amazon_removal_shipments sh ON d.source_table = 'amazon_removal_shipments' AND sh.id = d.source_row_id::uuid AND sh.organization_id = d.organization_id
    WHERE d.resolved_product_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = d.resolved_product_id)
      AND NOT EXISTS (SELECT 1 FROM public.claim_reference_edges e WHERE e.draft_id = d.id)
  `);

  const sampleRes = await pgClient.query(
    `
    SELECT d.id::text, d.organization_id::text, d.store_id::text, d.source_table, d.source_row_id::text, d.sku
    FROM public.claim_candidate_drafts d
    WHERE d.resolved_product_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = d.resolved_product_id)
      AND NOT EXISTS (SELECT 1 FROM public.claim_reference_edges e WHERE e.draft_id = d.id)
    ORDER BY md5(d.id::text)
    LIMIT $1
  `,
    [sampleSize],
  );

  await pgClient.end();

  const outcomeCounts: Record<string, number> = {};
  const candidateEdgeEstimate = { total_candidates: 0, drafts_with_candidates: 0, drafts_zero_candidates: 0 };
  const samples: Array<Record<string, unknown>> = [];

  for (const row of sampleRes.rows as Record<string, unknown>[]) {
    const draft = toDraftRow(row);
    try {
      const resp = await loadAndBuildReferenceCandidatesForDraft(supabase, draft, { limit: 80 });
      outcomeCounts[resp.outcome] = (outcomeCounts[resp.outcome] ?? 0) + 1;
      if (resp.candidate_count > 0) {
        candidateEdgeEstimate.drafts_with_candidates++;
        candidateEdgeEstimate.total_candidates += resp.candidate_count;
      } else {
        candidateEdgeEstimate.drafts_zero_candidates++;
      }
      if (samples.length < 25) {
        samples.push({
          draft_id: draft.id,
          source_table: draft.source_table,
          outcome: resp.outcome,
          candidate_count: resp.candidate_count,
          order_id: resp.operational?.order_id ?? null,
          warnings: resp.warnings.map((w) => w.code),
        });
      }
    } catch (e) {
      outcomeCounts.error = (outcomeCounts.error ?? 0) + 1;
      if (samples.length < 25) {
        samples.push({ draft_id: draft.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  const fkOkNoEdges = Number(cohort.rows[0]?.fk_ok_no_edges ?? 0);
  const scaledEdgeEstimate = Math.round(
    (candidateEdgeEstimate.total_candidates / Math.max(sampleRes.rows.length, 1)) * fkOkNoEdges,
  );

  const manifest = {
    prompt: "CLAIM-EVIDENCE-ENRICHMENT-DRYRUN-V193",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "dry_run_only",
    v191_prerequisite_run: V191_RUN,
    cohort_fk_valid_no_edges: fkOkNoEdges,
    by_source_table: bySource.rows,
    order_id_heuristic: orderIdHeuristic.rows[0],
    sample_size: sampleRes.rows.length,
    sample_outcome_counts: outcomeCounts,
    sample_candidate_stats: candidateEdgeEstimate,
    scaled_edge_insert_estimate: scaledEdgeEstimate,
    edges_inserted: 0,
    execute_eligible: candidateEdgeEstimate.drafts_with_candidates > 0,
    status: "PASS",
    next_prompt: "CLAIM-EVIDENCE-ENRICHMENT-EXECUTE-V194",
    secondary_prompt: "AMAZON-REMOVALS-SOURCE-REINGEST-DRYRUN-V193B",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "enrichment-sample.json"), JSON.stringify(samples, null, 2));
  fs.writeFileSync(
    path.join(outDir, "rollback-preimage-proposals.json"),
    JSON.stringify({ note: "No claim_reference_edges INSERT in V193 dry-run", sample_proposals: samples }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-EVIDENCE-ENRICHMENT-DRYRUN-V193",
      "",
      `- run_id: \`${runId}\``,
      `- mode: **dry-run only** (no edge INSERT)`,
      "",
      "## Cohort",
      `- FK-valid drafts without reference edges: **${fkOkNoEdges}**`,
      "",
      `## Sample TRID build (${sampleRes.rows.length} drafts)`,
      ...Object.entries(outcomeCounts).map(([k, v]) => `- outcome \`${k}\`: **${v}**`),
      `- drafts with ≥1 candidate: **${candidateEdgeEstimate.drafts_with_candidates}**`,
      `- total reference candidates (sample): **${candidateEdgeEstimate.total_candidates}**`,
      `- scaled edge estimate (full cohort): **~${scaledEdgeEstimate}**`,
      "",
      "Operator approval required before `claim_reference_edges` INSERT.",
    ].join("\n"),
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
