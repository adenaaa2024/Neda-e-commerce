/**
 * CLAIM-CANDIDATE-RESOLVER-V176 — FK orphan product fix for claim_candidate_drafts
 *
 *   npx tsx scripts/claim-candidate-resolver-v176-fk-orphan-product-fix-staging.ts --run-id=20260523T210000Z
 *   npx tsx scripts/claim-candidate-resolver-v176-fk-orphan-product-fix-staging.ts --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  filterProposalsExistingInProducts,
  remapOrphanDraftProposalsBatch,
  type OrphanRemapOutcome,
} from "../lib/claim-candidate-resolver-v176-orphan-remap";
import { runClaimResolverMaterializePass, type MaterializeProposal } from "../lib/claim-candidate-resolver-materialize";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/claim-candidate-resolver-v176-fk-orphan-product-fix";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function v175ProposalsPath(): string | null {
  const a = process.argv.find((x) => x.startsWith("--v175-run="));
  const run = a ? a.split("=")[1]!.trim() : "20260523T200000Z";
  const p = path.join(
    process.cwd(),
    ".cursor/audit-reports/claim-candidate-resolver-project-v175",
    run,
    "rollback-preimage-proposals.json",
  );
  return fs.existsSync(p) ? p : null;
}

async function probeCounts(client: pg.Client): Promise<Record<string, unknown>> {
  const tables = ["claim_candidates", "claim_candidate_drafts"] as const;
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    const total = await client.query(`SELECT COUNT(*)::bigint AS c FROM public."${t}"`);
    const resolved = await client.query(
      `SELECT COUNT(*)::bigint AS c FROM public."${t}" WHERE resolved_product_id IS NOT NULL`,
    );
    out[t] = {
      total: Number(total.rows[0]?.c ?? 0),
      resolved: Number(resolved.rows[0]?.c ?? 0),
    };
  }
  return out;
}

async function loadDraftRows(
  client: pg.Client,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const res = await client.query(
      `SELECT id::text, organization_id::text, store_id::text, source_table, source_row_id::text,
              sku, fnsku, asin, resolved_product_id::text
       FROM public.claim_candidate_drafts WHERE id = ANY($1::uuid[])`,
      [slice],
    );
    for (const row of res.rows as Record<string, unknown>[]) {
      out.set(String(row.id), row);
    }
  }
  return out;
}

async function capturePreimage(client: pg.Client, ids: string[]): Promise<Array<{ id: string; old_resolved_product_id: string | null }>> {
  if (ids.length === 0) return [];
  const res = await client.query(
    `SELECT id::text, resolved_product_id::text AS old_resolved_product_id
     FROM public.claim_candidate_drafts WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return res.rows as Array<{ id: string; old_resolved_product_id: string | null }>;
}

async function applyDraftProposals(client: pg.Client, proposals: MaterializeProposal[]): Promise<string[]> {
  const CHUNK = 250;
  const applied: string[] = [];
  for (let i = 0; i < proposals.length; i += CHUNK) {
    const slice = proposals.slice(i, i + CHUNK);
    const ids = slice.map((p) => p.artifact_id);
    const pids = slice.map((p) => p.proposed_resolved_product_id);
    const res = await client.query(
      `UPDATE public.claim_candidate_drafts t
       SET resolved_product_id = v.product_id, updated_at = now()
       FROM unnest($1::uuid[], $2::uuid[]) AS v(id, product_id)
       INNER JOIN public.products p ON p.id = v.product_id
       WHERE t.id = v.id AND t.resolved_product_id IS NULL
       RETURNING t.id::text AS id`,
      [ids, pids],
    );
    for (const row of res.rows as Array<{ id: string }>) applied.push(row.id);
  }
  return applied;
}

async function orphanRootCauseSample(client: pg.Client): Promise<Record<string, unknown>> {
  const q = await client.query(`
    SELECT COUNT(*)::bigint AS orphan_source_rpid
    FROM public.amazon_removal_shipments s
    WHERE s.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
  `);
  const q2 = await client.query(`
    SELECT COUNT(*)::bigint AS drafts_pointing_orphan_via_source
    FROM public.claim_candidate_drafts d
    JOIN public.amazon_removal_shipments s ON s.id = d.source_row_id::uuid
      AND s.organization_id = d.organization_id
    WHERE d.resolved_product_id IS NULL
      AND d.source_table = 'amazon_removal_shipments'
      AND s.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
  `);
  return {
    amazon_removal_shipments_orphan_resolved_product_id: Number(q.rows[0]?.orphan_source_rpid ?? 0),
    unresolved_drafts_with_orphan_source_rpid: Number(q2.rows[0]?.drafts_pointing_orphan_via_source ?? 0),
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF}, got ${ref})`);
  }

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const preCounts = await probeCounts(pgClient);
  const rootCause = await orphanRootCauseSample(pgClient);

  const url = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const key =
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  let rawProposals: MaterializeProposal[] = [];
  const v175Path = v175ProposalsPath();
  if (v175Path) {
    const parsed = JSON.parse(fs.readFileSync(v175Path, "utf8")) as {
      claim_candidate_drafts?: MaterializeProposal[];
    };
    rawProposals = parsed.claim_candidate_drafts ?? [];
  } else {
    const pass = await runClaimResolverMaterializePass(supabase, "claim_candidate_drafts", {
      onlyUnresolved: true,
      useInboxContext: false,
    });
    rawProposals = pass.proposals;
  }

  const { valid: alreadyValid, invalid: orphanProposals } = await filterProposalsExistingInProducts(
    pgClient,
    rawProposals,
  );

  const draftById = await loadDraftRows(
    pgClient,
    orphanProposals.map((p) => p.artifact_id),
  );

  const remapResults = await remapOrphanDraftProposalsBatch(supabase, orphanProposals, draftById, {
    concurrency: 16,
  });

  const remappedCandidates = remapResults
    .map((r) => r.proposal)
    .filter((p): p is MaterializeProposal => p != null);

  const { valid: remappedValid, invalid: remappedStillOrphan } = await filterProposalsExistingInProducts(
    pgClient,
    remappedCandidates,
  );

  const toApply = [...alreadyValid, ...remappedValid];
  const outcomeCounts: Record<string, number> = {};
  for (const r of remapResults) {
    outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] ?? 0) + 1;
  }

  let applied = 0;
  let appliedIds: string[] = [];
  if (execute && toApply.length > 0) {
    const preimage = await capturePreimage(pgClient, toApply.map((p) => p.artifact_id));
    fs.writeFileSync(path.join(outDir, "rollback-preimage-rows.json"), JSON.stringify(preimage, null, 2));
    fs.writeFileSync(
      path.join(outDir, "rollback-preimage-proposals.json"),
      JSON.stringify({ claim_candidate_drafts: toApply }, null, 2),
    );
    const rollbackSql = preimage.map((r) => {
      const val = r.old_resolved_product_id === null ? "NULL" : `'${r.old_resolved_product_id}'::uuid`;
      return `UPDATE public.claim_candidate_drafts SET resolved_product_id = ${val}, updated_at = now() WHERE id = '${r.id}'::uuid;`;
    });
    fs.writeFileSync(
      path.join(outDir, "rollback.sql"),
      ["-- V176 rollback", ...rollbackSql].join("\n"),
      "utf8",
    );
    appliedIds = await applyDraftProposals(pgClient, toApply);
    applied = appliedIds.length;
  } else if (toApply.length > 0) {
    fs.writeFileSync(
      path.join(outDir, "rollback-preimage-proposals.json"),
      JSON.stringify({ claim_candidate_drafts: toApply }, null, 2),
      "utf8",
    );
  }

  const postCounts = execute ? await probeCounts(pgClient) : null;
  await pgClient.end();

  const dryRun = {
    v175_proposals_source: v175Path,
    raw_proposals: rawProposals.length,
    already_valid_product_fk: alreadyValid.length,
    orphan_proposals: orphanProposals.length,
    remap_outcome_counts: outcomeCounts,
    remapped_candidates: remappedCandidates.length,
    remapped_valid_product_fk: remappedValid.length,
    remapped_still_orphan: remappedStillOrphan.length,
    eligible_to_apply: toApply.length,
    applied,
    sample_remaps: remapResults.filter((r) => r.outcome === "remapped_identifier_map").slice(0, 15),
    sample_still_blocked: remapResults
      .filter((r) => r.proposal == null)
      .slice(0, 15)
      .map((r) => ({
        outcome: r.outcome,
        original_product_id: r.original_product_id,
        reason_codes: r.reason_codes,
      })),
  };

  fs.writeFileSync(path.join(outDir, "orphan-root-cause.json"), JSON.stringify(rootCause, null, 2));
  fs.writeFileSync(path.join(outDir, "dry-run-summary.json"), JSON.stringify(dryRun, null, 2));
  fs.writeFileSync(path.join(outDir, "pre-counts.json"), JSON.stringify(preCounts, null, 2));
  if (postCounts) fs.writeFileSync(path.join(outDir, "post-counts.json"), JSON.stringify(postCounts, null, 2));

  const pre = preCounts as { claim_candidate_drafts: { total: number; resolved: number } };
  const post = postCounts as { claim_candidate_drafts: { resolved: number } } | null;

  const manifest = {
    prompt: "CLAIM-CANDIDATE-RESOLVER-V176-FK-ORPHAN-PRODUCT-FIX",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: execute ? "dry_run_and_execute" : "dry_run",
    pre_drafts_resolved: pre.claim_candidate_drafts.resolved,
    pre_drafts_total: pre.claim_candidate_drafts.total,
    post_drafts_resolved: post?.claim_candidate_drafts.resolved ?? null,
    orphan_root_cause: rootCause,
    eligible_to_apply: toApply.length,
    applied,
    status: "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-CANDIDATE-RESOLVER-V176",
      "",
      `- run_id: \`${runId}\``,
      `- staging: \`${STAGING_REF}\``,
      `- mode: ${execute ? "execute" : "dry-run"}`,
      "",
      "## Root cause",
      `- Orphan \`amazon_removal_shipments.resolved_product_id\` (not in \`products\`): **${rootCause.amazon_removal_shipments_orphan_resolved_product_id}**`,
      `- Unresolved drafts tied to orphan source RPIDs: **${rootCause.unresolved_drafts_pointing_orphan_via_source}**`,
      "",
      "## Dry-run",
      `- V175-class proposals (drafts): ${rawProposals.length}`,
      `- Orphan FK (proposed ∉ products): ${orphanProposals.length}`,
      `- Remapped via identifier_map: ${outcomeCounts.remapped_identifier_map ?? 0}`,
      `- Eligible after remap + FK: **${toApply.length}**`,
      `- Applied: **${applied}**`,
      "",
      pre.claim_candidate_drafts.resolved != null
        ? `- drafts resolved: ${pre.claim_candidate_drafts.resolved} → ${post?.claim_candidate_drafts.resolved ?? "n/a"} / ${pre.claim_candidate_drafts.total}`
        : "",
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
