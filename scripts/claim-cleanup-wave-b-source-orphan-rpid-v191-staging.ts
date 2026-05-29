/**
 * CLAIM-CLEANUP-WAVE-B-SOURCE-ORPHAN-RPID-V191 — staging dry-run (read-only).
 *
 *   npx tsx scripts/claim-cleanup-wave-b-source-orphan-rpid-v191-staging.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  fetchCandidateSourceContextMap,
  projectClaimArtifactsBatchCore,
} from "../lib/claim-artifact-projection-core";
import {
  mergeOperationalHints,
  resolveAmazonRemovalsOperationalRow,
} from "../lib/claim-operational-source-resolve";
import {
  filterProposalsExistingInProducts,
  remapOrphanDraftProposalsBatch,
} from "../lib/claim-candidate-resolver-v176-orphan-remap";
import { runClaimResolverMaterializePass } from "../lib/claim-candidate-resolver-materialize";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/claim-cleanup-wave-b-source-orphan-rpid-v191";
const PC05_RUN = "20260525T180000Z";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
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
  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const pc05Path = path.join(process.cwd(), ".cursor/audit-reports/pc05-claim-engine-readiness-census", PC05_RUN, "manifest.json");
  const pc05Baseline = fs.existsSync(pc05Path) ? JSON.parse(fs.readFileSync(pc05Path, "utf8")) : null;

  const removalsCandidates = await pgClient.query(`
    SELECT id::text, organization_id::text, store_id::text, source_table, source_row_id::text,
           sku, fnsku, asin, resolved_product_id::text
    FROM public.claim_candidates
    WHERE source_table = 'amazon_removals' AND resolved_product_id IS NULL
    ORDER BY id
  `);

  const repairOutcomes: Record<string, number> = {
    already_has_source_row: 0,
    alternate_key_repair_proposal: 0,
    operational_ambiguous: 0,
    still_missing_source: 0,
    projection_missing_source_row: 0,
  };
  const repairProposals: Array<Record<string, unknown>> = [];

  const rows = removalsCandidates.rows as Array<Record<string, string | null>>;
  const CHUNK = 80;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const ctxMap = await fetchCandidateSourceContextMap(
      supabase,
      slice.map((r) => r.id!),
    );
    const projected = await projectClaimArtifactsBatchCore(
      supabase,
      slice as unknown as Record<string, unknown>[],
      String(slice[0]?.organization_id ?? ""),
      fetchCandidateSourceContextMap,
    );

    for (const row of slice) {
      const id = row.id!;
      const proj = projected.get(id);
      if (proj?.final_bucket === "missing_source_row") repairOutcomes.projection_missing_source_row++;

      const exact = await pgClient.query(
        `SELECT id::text FROM public.amazon_removals WHERE id = $1::uuid AND organization_id = $2::uuid LIMIT 1`,
        [row.source_row_id, row.organization_id],
      );
      if ((exact.rowCount ?? 0) > 0) {
        repairOutcomes.already_has_source_row++;
        continue;
      }

      const hints = mergeOperationalHints(row as unknown as Record<string, unknown>, ctxMap.get(id) ?? null);
      const alt = await resolveAmazonRemovalsOperationalRow(
        supabase,
        row.organization_id!,
        row.store_id,
        row.source_row_id,
        hints,
      );

      if (alt.row && !alt.ambiguous) {
        repairOutcomes.alternate_key_repair_proposal++;
        if (repairProposals.length < 50) {
          repairProposals.push({
            claim_candidate_id: id,
            old_source_row_id: row.source_row_id,
            proposed_source_row_id: String(alt.row.id),
            matched_via: alt.matched_via,
            reason_codes: alt.reason_codes,
            action: "DRY_RUN_ONLY_update_source_row_id_on_execute",
          });
        }
      } else if (alt.ambiguous) {
        repairOutcomes.operational_ambiguous++;
      } else {
        repairOutcomes.still_missing_source++;
      }
    }
  }

  const orphanShipments = await pgClient.query(`
    SELECT COUNT(*)::bigint AS orphan_shipments
    FROM public.amazon_removal_shipments s
    WHERE s.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
  `);
  const orphanSourceDrafts = await pgClient.query(`
    SELECT COUNT(*)::bigint AS c
    FROM public.claim_candidate_drafts d
    JOIN public.amazon_removal_shipments s ON s.id = d.source_row_id::uuid AND s.organization_id = d.organization_id
    WHERE d.resolved_product_id IS NULL AND d.source_table = 'amazon_removal_shipments'
      AND s.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
  `);

  const cdPass = await runClaimResolverMaterializePass(supabase, "claim_candidate_drafts", {
    onlyUnresolved: true,
    useInboxContext: false,
  });
  const { invalid: orphanProposals } = await filterProposalsExistingInProducts(pgClient, cdPass.proposals);
  let remapRemapped = 0;
  let remapStillBlocked = 0;
  if (orphanProposals.length > 0) {
    const draftById = new Map<string, Record<string, unknown>>();
    const ids = orphanProposals.slice(0, 200).map((p) => p.artifact_id);
    const dr = await pgClient.query(
      `SELECT id::text, organization_id::text, store_id::text, source_table, source_row_id::text, sku, fnsku, asin
       FROM public.claim_candidate_drafts WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    for (const r of dr.rows as Record<string, unknown>[]) draftById.set(String(r.id), r);
    const remaps = await remapOrphanDraftProposalsBatch(supabase, orphanProposals.slice(0, 200), draftById);
    for (const r of remaps) {
      if (r.outcome === "remapped_identifier_map") remapRemapped++;
      else remapStillBlocked++;
    }
  }

  const evidenceGraph = await pgClient.query(`
    SELECT
      (SELECT COUNT(*)::bigint FROM public.claim_candidate_drafts) AS drafts_total,
      (SELECT COUNT(*)::bigint FROM public.claim_candidate_drafts d
       WHERE NOT EXISTS (SELECT 1 FROM public.claim_reference_edges e WHERE e.draft_id = d.id)) AS drafts_no_edges,
      (SELECT COUNT(*)::bigint FROM public.claim_candidate_drafts d
       WHERE d.resolved_product_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = d.resolved_product_id)
         AND NOT EXISTS (SELECT 1 FROM public.claim_reference_edges e WHERE e.draft_id = d.id)) AS fk_ok_no_edges,
      (SELECT COUNT(*)::bigint FROM public.claim_enrichment_generations) AS generations,
      (SELECT COUNT(*)::bigint FROM public.claim_reference_edges) AS edges
  `);

  await pgClient.end();

  const executeEligible =
    repairOutcomes.alternate_key_repair_proposal > 0 || remapRemapped > 0;

  const manifest = {
    prompt: "CLAIM-CLEANUP-WAVE-B-SOURCE-ORPHAN-RPID-V191",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "dry_run_only",
    pc05_baseline_run: PC05_RUN,
    pc05_baseline: pc05Baseline,
    amazon_removals_missing_source_candidates: rows.length,
    repair_outcomes: repairOutcomes,
    orphan_rpid: {
      amazon_removal_shipments_orphan_resolved: Number(orphanShipments.rows[0]?.orphan_shipments ?? 0),
      unresolved_drafts_tied_to_orphan_source: Number(orphanSourceDrafts.rows[0]?.c ?? 0),
      orphan_proposals_in_dry_scan: orphanProposals.length,
      sample_remap_remapped: remapRemapped,
      sample_remap_still_blocked: remapStillBlocked,
    },
    evidence_graph_prerequisites: evidenceGraph.rows[0],
    execute_eligible_after_operator_approval: executeEligible,
    applied: 0,
    status: "PASS",
    next_prompt: "CLAIM-REGENERATION-DRYRUN-V192",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "repair-proposals-sample.json"), JSON.stringify(repairProposals, null, 2));
  fs.writeFileSync(
    path.join(outDir, "rollback-preimage-proposals.json"),
    JSON.stringify({ source_row_repairs: repairProposals, note: "No claim table writes in V191 dry-run" }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-CLEANUP-WAVE-B-SOURCE-ORPHAN-RPID-V191",
      "",
      `- run_id: \`${runId}\``,
      `- mode: **dry-run only** (no claim table writes)`,
      "",
      "## amazon_removals missing source (claim_candidates)",
      `- candidates scanned: **${rows.length}**`,
      `- alternate-key repair proposals: **${repairOutcomes.alternate_key_repair_proposal}**`,
      `- still missing: **${repairOutcomes.still_missing_source}**`,
      `- operational ambiguous: **${repairOutcomes.operational_ambiguous}**`,
      "",
      "## Orphan source RPID",
      `- orphan amazon_removal_shipments.resolved_product_id: **${orphanShipments.rows[0]?.orphan_shipments}**`,
      `- unresolved drafts tied to orphan source: **${orphanSourceDrafts.rows[0]?.c}**`,
      `- sample orphan remap via map: **${remapRemapped}** / blocked **${remapStillBlocked}** (200 sample)`,
      "",
      "## Evidence graph prerequisites",
      `- drafts without reference edges: **${evidenceGraph.rows[0]?.drafts_no_edges}**`,
      `- FK-ok drafts still without edges: **${evidenceGraph.rows[0]?.fk_ok_no_edges}**`,
      "",
      executeEligible
        ? "**Execute not run** — dry-run shows repair/remap candidates; operator approval required."
        : "**No execute candidates** in this sample — upstream import/re-ingest may be required.",
      "",
      "Next: **CLAIM-REGENERATION-DRYRUN-V192**",
    ].join("\n"),
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
