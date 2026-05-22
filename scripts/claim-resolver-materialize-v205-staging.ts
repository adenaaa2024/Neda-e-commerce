/**
 * V205 — claim resolver materialize (staging) after V203/V204 cleanup.
 *
 *   npx tsx scripts/claim-resolver-materialize-v205-staging.ts --run-id=20260522T210000Z
 *   npx tsx scripts/claim-resolver-materialize-v205-staging.ts --run-id=20260522T210000Z --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  buildBlockerInventory,
  buildResolverReadinessMatrix,
  runClaimResolverMaterializePass,
  type ClaimArtifactTable,
  type MaterializeProposal,
} from "../lib/claim-candidate-resolver-materialize";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/v205-claim-resolver-materialize";
const APPROVAL_REL = ".cursor/operator-approvals/claim-resolver-materialize-v205-approval.md";
const QUARANTINE_STATUSES = ["quarantined_missing_source", "archived_missing_source"] as const;

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

function approvalOk(): boolean {
  const p = path.join(process.cwd(), APPROVAL_REL);
  if (!fs.existsSync(p)) return false;
  return /APPROVED_TO_RUN_STAGING[\s\S]*?\|\s*`?true`?\s*\|/i.test(fs.readFileSync(p, "utf8"));
}

async function loadQuarantinedCandidateIds(client: pg.Client): Promise<Set<string>> {
  const res = await client.query(
    `SELECT id::text FROM public.claim_candidates
     WHERE candidate_status = ANY($1::text[])`,
    [QUARANTINE_STATUSES],
  );
  return new Set((res.rows as Array<{ id: string }>).map((r) => r.id));
}

async function filterProposalsWithValidProducts(
  client: pg.Client,
  proposals: MaterializeProposal[],
): Promise<{ valid: MaterializeProposal[]; invalid_product_fk: number }> {
  if (proposals.length === 0) return { valid: [], invalid_product_fk: 0 };
  const ids = proposals.map((p) => p.proposed_resolved_product_id);
  const res = await client.query(
    `SELECT x.id::text AS product_id
     FROM unnest($1::uuid[]) AS x(id)
     INNER JOIN public.products p ON p.id = x.id AND p.deleted_at IS NULL`,
    [ids],
  );
  const ok = new Set(res.rows.map((r: { product_id: string }) => r.product_id));
  const valid = proposals.filter((p) => ok.has(p.proposed_resolved_product_id));
  return { valid, invalid_product_fk: proposals.length - valid.length };
}

async function countOrphanFk(client: pg.Client, table: ClaimArtifactTable): Promise<number> {
  const res = await client.query(`
    SELECT COUNT(*)::bigint AS c FROM public."${table}" t
    WHERE t.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = t.resolved_product_id)
  `);
  return Number(res.rows[0]?.c ?? 0);
}

async function probeCounts(client: pg.Client) {
  const out: Record<string, unknown> = {};
  for (const t of ["claim_candidates", "claim_candidate_drafts"] as const) {
    const r = await client.query(`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved,
        COUNT(*) FILTER (
          WHERE resolved_product_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = resolved_product_id AND p.deleted_at IS NULL)
        )::bigint AS strict_valid
      FROM public."${t}"
    `);
    const total = Number(r.rows[0]?.total ?? 0);
    const resolved = Number(r.rows[0]?.resolved ?? 0);
    const strictValid = Number(r.rows[0]?.strict_valid ?? 0);
    out[t] = {
      total,
      resolved,
      unresolved: total - resolved,
      strict_valid: strictValid,
      loose_pct: total ? Math.round((resolved / total) * 1000) / 10 : 0,
      strict_pct: total ? Math.round((strictValid / total) * 1000) / 10 : 0,
    };
  }
  return out;
}

async function capturePreimage(client: pg.Client, table: ClaimArtifactTable, ids: string[]) {
  if (ids.length === 0) return [];
  const res = await client.query(
    `SELECT id::text, resolved_product_id::text AS old_resolved_product_id
     FROM public."${table}" WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return res.rows as Array<{ id: string; old_resolved_product_id: string | null }>;
}

async function applyProposalsViaPg(
  client: pg.Client,
  table: ClaimArtifactTable,
  proposals: MaterializeProposal[],
): Promise<string[]> {
  const appliedIds: string[] = [];
  const CHUNK = 250;
  for (let i = 0; i < proposals.length; i += CHUNK) {
    const slice = proposals.slice(i, i + CHUNK);
    const res = await client.query(
      `UPDATE public."${table}" t
       SET resolved_product_id = v.product_id, updated_at = now()
       FROM unnest($1::uuid[], $2::uuid[]) AS v(id, product_id)
       INNER JOIN public.products p ON p.id = v.product_id AND p.deleted_at IS NULL
       WHERE t.id = v.id AND t.resolved_product_id IS NULL
       RETURNING t.id::text AS id`,
      [slice.map((p) => p.artifact_id), slice.map((p) => p.proposed_resolved_product_id)],
    );
    for (const row of res.rows as Array<{ id: string }>) appliedIds.push(row.id);
  }
  return appliedIds;
}

function writeRollbackSql(outDir: string, rows: Array<{ id: string; old_resolved_product_id: string | null; table: string }>) {
  const lines = ["-- V205 rollback", "BEGIN;"];
  for (const r of rows) {
    const val = r.old_resolved_product_id ? `'${r.old_resolved_product_id}'::uuid` : "NULL";
    lines.push(
      `UPDATE public.${r.table} SET resolved_product_id = ${val}, updated_at = now() WHERE id = '${r.id}'::uuid;`,
    );
  }
  lines.push("COMMIT;");
  fs.writeFileSync(path.join(outDir, "rollback.sql"), lines.join("\n"), "utf8");
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
    throw new Error(`Staging guard failed (expected ${STAGING_REF})`);
  }
  if (execute && !approvalOk()) throw new Error(`Execute blocked: ${APPROVAL_REL}`);

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const preCounts = await probeCounts(pgClient);
  const preOrphan = {
    claim_candidates: await countOrphanFk(pgClient, "claim_candidates"),
    claim_candidate_drafts: await countOrphanFk(pgClient, "claim_candidate_drafts"),
  };
  const quarantinedIds = await loadQuarantinedCandidateIds(pgClient);

  const url = publicUrl;
  const key =
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const passOpts = { onlyUnresolved: true as const };
  const ccPass = await runClaimResolverMaterializePass(supabase, "claim_candidates", {
    ...passOpts,
    useInboxContext: true,
  });
  const cdPass = await runClaimResolverMaterializePass(supabase, "claim_candidate_drafts", {
    ...passOpts,
    useInboxContext: false,
  });

  const ccFiltered = ccPass.proposals.filter((p) => !quarantinedIds.has(p.artifact_id));
  const excludedQuarantine = ccPass.proposals.length - ccFiltered.length;

  const rawProposals = [...ccFiltered, ...cdPass.proposals];
  const { valid: allProposals, invalid_product_fk } = await filterProposalsWithValidProducts(pgClient, rawProposals);

  const ccProps = allProposals.filter((p) =>
    ccFiltered.some((x) => x.artifact_id === p.artifact_id),
  );
  const cdProps = allProposals.filter((p) =>
    cdPass.proposals.some((x) => x.artifact_id === p.artifact_id),
  );

  const pre = preCounts as {
    claim_candidates: { total: number; resolved: number };
    claim_candidate_drafts: { total: number; resolved: number };
  };

  const matrix = buildResolverReadinessMatrix({
    claimCandidates: ccPass.metrics,
    claimDrafts: cdPass.metrics,
    preCounts: {
      claim_candidates_total: pre.claim_candidates.total,
      claim_candidates_resolved: pre.claim_candidates.resolved,
      drafts_total: pre.claim_candidate_drafts.total,
      drafts_resolved: pre.claim_candidate_drafts.resolved,
    },
  });

  let appliedCc = 0;
  let appliedCd = 0;
  if (execute && allProposals.length > 0) {
    const rollbackRows: Array<{ id: string; old_resolved_product_id: string | null; table: string }> = [];
    if (ccProps.length > 0) {
      rollbackRows.push(
        ...(await capturePreimage(pgClient, "claim_candidates", ccProps.map((p) => p.artifact_id))).map((r) => ({
          ...r,
          table: "claim_candidates",
        })),
      );
      appliedCc = (await applyProposalsViaPg(pgClient, "claim_candidates", ccProps)).length;
    }
    if (cdProps.length > 0) {
      rollbackRows.push(
        ...(await capturePreimage(pgClient, "claim_candidate_drafts", cdProps.map((p) => p.artifact_id))).map(
          (r) => ({ ...r, table: "claim_candidate_drafts" }),
        ),
      );
      appliedCd = (await applyProposalsViaPg(pgClient, "claim_candidate_drafts", cdProps)).length;
    }
    fs.writeFileSync(path.join(outDir, "rollback-preimage-rows.json"), JSON.stringify(rollbackRows, null, 2));
    writeRollbackSql(outDir, rollbackRows);
    fs.writeFileSync(
      path.join(outDir, "rollback-preimage-proposals.json"),
      JSON.stringify({ claim_candidates: ccProps, claim_candidate_drafts: cdProps }, null, 2),
    );
  } else if (allProposals.length > 0) {
    fs.writeFileSync(
      path.join(outDir, "rollback-preimage-proposals.json"),
      JSON.stringify({ claim_candidates: ccProps, claim_candidate_drafts: cdProps }, null, 2),
    );
  }

  const postCounts = execute ? await probeCounts(pgClient) : null;
  const postOrphan = execute
    ? {
        claim_candidates: await countOrphanFk(pgClient, "claim_candidates"),
        claim_candidate_drafts: await countOrphanFk(pgClient, "claim_candidate_drafts"),
      }
    : preOrphan;

  await pgClient.end();

  const dryRun = {
    pre_orphan_fk: preOrphan,
    post_orphan_fk: postOrphan,
    quarantined_candidates_excluded_from_apply: excludedQuarantine,
    claim_candidates: ccPass.metrics,
    claim_candidate_drafts: cdPass.metrics,
    eligible_raw: rawProposals.length + excludedQuarantine,
    eligible_after_quarantine_filter: rawProposals.length,
    eligible_after_product_fk: allProposals.length,
    invalid_product_fk_skipped: invalid_product_fk,
    proposal_from_counts: allProposals.reduce(
      (acc, p) => {
        acc[p.proposal_from] = (acc[p.proposal_from] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    ),
    sample_proposals: allProposals.slice(0, 20),
  };

  fs.writeFileSync(path.join(outDir, "pre-counts.json"), JSON.stringify(preCounts, null, 2));
  if (postCounts) fs.writeFileSync(path.join(outDir, "post-counts.json"), JSON.stringify(postCounts, null, 2));
  fs.writeFileSync(path.join(outDir, "dry-run-summary.json"), JSON.stringify(dryRun, null, 2));
  fs.writeFileSync(path.join(outDir, "filing-readiness-matrix.json"), JSON.stringify(matrix, null, 2));
  fs.writeFileSync(
    path.join(outDir, "blocker-inventory.json"),
    JSON.stringify(buildBlockerInventory(ccPass.metrics, cdPass.metrics), null, 2),
  );

  const applied = appliedCc + appliedCd;
  const fkOk = postOrphan.claim_candidates === 0 && postOrphan.claim_candidate_drafts === 0;
  const status = !execute ? "DRY_RUN_OK" : fkOk ? "PASS" : "FAIL";

  const manifest = {
    prompt: "V205-CLAIM-RESOLVER-MATERIALIZE",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: execute ? "dry_run_and_execute" : "dry_run",
    preconditions: {
      v203: "20260522T190000Z",
      v204: "20260522T200000Z",
    },
    applied: { claim_candidates: appliedCc, claim_candidate_drafts: appliedCd, total: applied },
    eligible_after_fk: allProposals.length,
    orphan_fk_after: postOrphan,
    status,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-summary.md"),
    [
      "# V205 — claim resolver materialize",
      "",
      `- run_id: \`${runId}\``,
      `- mode: ${execute ? "**execute**" : "dry-run"}`,
      "",
      "## Dry-run",
      `- Candidates eligible (post-quarantine): **${ccFiltered.length}** (${excludedQuarantine} quarantined excluded)`,
      `- Drafts eligible: **${cdPass.metrics.eligible_safe_update}**`,
      `- After products FK: **${allProposals.length}** (skipped invalid FK: ${invalid_product_fk})`,
      "",
      execute
        ? [
            "## Applied",
            `- claim_candidates: **${appliedCc}**`,
            `- claim_candidate_drafts: **${appliedCd}**`,
            `- Orphan FK after: candidates **${postOrphan.claim_candidates}**, drafts **${postOrphan.claim_candidate_drafts}**`,
          ].join("\n")
        : "Run with `--execute` after approval.",
      "",
      `Status: **${status}**`,
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
  if (execute && !fkOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
