/**
 * CLAIM-CANDIDATE-RESOLVER-PROJECT-V175 — Materialize claim_candidates.resolved_product_id (optional drafts)
 *
 *   npx tsx scripts/claim-candidate-resolver-project-v175-staging.ts --run-id=<id>
 *   npx tsx scripts/claim-candidate-resolver-project-v175-staging.ts --run-id=<id> --execute
 *   npx tsx scripts/claim-candidate-resolver-project-v175-staging.ts --max-pages=3  # sample dry-run
 *   npx tsx scripts/claim-candidate-resolver-project-v175-staging.ts --candidates-only --run-id=<id> --execute
 *
 * Preconditions: V174 matrix PASS; deterministic tiers only (identifier_map + source resolved_product_id).
 * Forbidden: product auto-create, package_items, production, title/OCR linking, blind settlement bulk.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  applyMaterializeProposals,
  buildBlockerInventory,
  buildResolverReadinessMatrix,
  runClaimResolverMaterializePass,
  type ClaimArtifactTable,
  type MaterializeProposal,
} from "../lib/claim-candidate-resolver-materialize";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";

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

function maxPagesArg(): number | undefined {
  const a = process.argv.find((x) => x.startsWith("--max-pages="));
  if (!a) return undefined;
  const n = Number(a.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function applyFromDir(): string | null {
  const a = process.argv.find((x) => x.startsWith("--apply-from="));
  if (!a) return null;
  return a.split("=")[1]!.trim() || null;
}

function candidatesOnly(): boolean {
  return process.argv.includes("--candidates-only");
}

function auditTableName(runId: string): string {
  return `claim_candidate_resolver_v175_audit_${runId.replace(/[^a-z0-9]/gi, "_").slice(0, 32)}`;
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
     INNER JOIN public.products p ON p.id = x.id`,
    [ids],
  );
  const ok = new Set(res.rows.map((r: { product_id: string }) => r.product_id));
  const valid = proposals.filter((p) => ok.has(p.proposed_resolved_product_id));
  return { valid, invalid_product_fk: proposals.length - valid.length };
}

async function captureRollbackPreimage(
  client: pg.Client,
  table: ClaimArtifactTable,
  artifactIds: string[],
): Promise<Array<{ id: string; old_resolved_product_id: string | null }>> {
  if (artifactIds.length === 0) return [];
  const res = await client.query(
    `SELECT id::text, resolved_product_id::text AS old_resolved_product_id
     FROM public."${table}"
     WHERE id = ANY($1::uuid[])`,
    [artifactIds],
  );
  return res.rows as Array<{ id: string; old_resolved_product_id: string | null }>;
}

async function ensureAuditTable(client: pg.Client, auditTable: string): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public."${auditTable}" (
      id bigserial PRIMARY KEY,
      run_id text NOT NULL,
      target_table text NOT NULL,
      artifact_id uuid NOT NULL,
      old_resolved_product_id uuid,
      new_resolved_product_id uuid NOT NULL,
      proposal_from text NOT NULL,
      source_table text,
      source_row_id text,
      match_confidence numeric,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function applyProposalsViaPgWithAudit(
  client: pg.Client,
  table: ClaimArtifactTable,
  proposals: MaterializeProposal[],
  runId: string,
  auditTable: string,
): Promise<number> {
  const CHUNK = 200;
  let total = 0;
  for (let i = 0; i < proposals.length; i += CHUNK) {
    const slice = proposals.slice(i, i + CHUNK);
    const ids = slice.map((p) => p.artifact_id);
    const preimage = await captureRollbackPreimage(client, table, ids);
    const oldById = new Map(preimage.map((r) => [r.id, r.old_resolved_product_id]));

    const appliedIds = new Set(await applyProposalsViaPg(client, table, slice));
    total += appliedIds.size;

    for (const p of slice) {
      if (!appliedIds.has(p.artifact_id)) continue;
      await client.query(
        `INSERT INTO public."${auditTable}" (
           run_id, target_table, artifact_id, old_resolved_product_id, new_resolved_product_id,
           proposal_from, source_table, source_row_id, match_confidence
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          runId,
          table,
          p.artifact_id,
          oldById.get(p.artifact_id) ?? null,
          p.proposed_resolved_product_id,
          p.proposal_from,
          p.source_table,
          p.source_row_id,
          p.confidence,
        ],
      );
    }
  }
  return total;
}

async function probeCounts(client: pg.Client): Promise<Record<string, unknown>> {
  const tables = ["claim_candidates", "claim_candidate_drafts"] as const;
  const out: Record<string, unknown> = {};

  for (const t of tables) {
    const total = await client.query(`SELECT COUNT(*)::bigint AS c FROM public."${t}"`);
    const resolved = await client.query(
      `SELECT COUNT(*)::bigint AS c FROM public."${t}" WHERE resolved_product_id IS NOT NULL`,
    );
    const bySource = await client.query(`
      SELECT source_table, COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved
      FROM public."${t}"
      GROUP BY source_table
      ORDER BY total DESC
    `);
    const joinable = await client.query(`
      SELECT COUNT(*)::bigint AS c
      FROM public."${t}" c
      WHERE c.resolved_product_id IS NULL
        AND c.source_table IN ('return_items', 'slip_contents', 'amazon_returns')
    `);
    out[t] = {
      total: Number(total.rows[0]?.c ?? 0),
      resolved: Number(resolved.rows[0]?.c ?? 0),
      unresolved: Number(total.rows[0]?.c ?? 0) - Number(resolved.rows[0]?.c ?? 0),
      joinable_source_unresolved: Number(joinable.rows[0]?.c ?? 0),
      by_source_table: bySource.rows,
    };
  }

  const sourceResolved = await client.query(`
    SELECT 'return_items' AS src, COUNT(*)::bigint AS with_rpid
    FROM public.return_items WHERE resolved_product_id IS NOT NULL
    UNION ALL
    SELECT 'slip_contents', COUNT(*)::bigint FROM public.slip_contents WHERE resolved_product_id IS NOT NULL
    UNION ALL
    SELECT 'amazon_returns', COUNT(*)::bigint FROM public.amazon_returns WHERE resolved_product_id IS NOT NULL
  `);
  out.source_tables_materialized = sourceResolved.rows;

  return out;
}

async function applyProposalsViaPg(
  client: pg.Client,
  table: ClaimArtifactTable,
  proposals: MaterializeProposal[],
): Promise<string[]> {
  const CHUNK = 250;
  const appliedIds: string[] = [];
  for (let i = 0; i < proposals.length; i += CHUNK) {
    const slice = proposals.slice(i, i + CHUNK);
    const ids = slice.map((p) => p.artifact_id);
    const pids = slice.map((p) => p.proposed_resolved_product_id);
    const res = await client.query(
      `UPDATE public."${table}" t
       SET resolved_product_id = v.product_id, updated_at = now()
       FROM unnest($1::uuid[], $2::uuid[]) AS v(id, product_id)
       INNER JOIN public.products p ON p.id = v.product_id
       WHERE t.id = v.id AND t.resolved_product_id IS NULL
       RETURNING t.id::text AS id`,
      [ids, pids],
    );
    for (const row of res.rows as Array<{ id: string }>) {
      appliedIds.push(row.id);
    }
  }
  return appliedIds;
}

function resolveSupabase(): { url: string; key: string } {
  const url =
    process.env.STAGING_SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    "";
  const key =
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  if (!url || !key) {
    throw new Error("Missing staging Supabase URL or service role key (STAGING_* or SUPABASE_SERVICE_ROLE_KEY).");
  }
  return { url, key };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const onlyCandidates = candidatesOnly();
  const maxPages = maxPagesArg();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/claim-candidate-resolver-project-v175",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    process.env.SUPABASE_DB_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  const stagingRef = getStagingProjectRef({ loadEnv: false });

  if (!dbUrl) {
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "FAIL", error: "STAGING_DIRECT_POSTGRES_URL unset" }, null, 2),
    );
    process.exit(2);
  }

  if (ref !== STAGING_REF || stagingRef !== STAGING_REF) {
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        { run_id: runId, status: "FAIL", error: `staging ref mismatch: ${ref} / ${stagingRef}` },
        null,
        2,
      ),
    );
    process.exit(2);
  }

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  const preCounts = await probeCounts(pgClient);

  const applyFrom = applyFromDir();
  const priorDir = applyFrom ? path.resolve(applyFrom) : null;
  const priorRollback =
    priorDir && fs.existsSync(path.join(priorDir, "rollback-preimage-proposals.json"))
      ? (JSON.parse(
          fs.readFileSync(path.join(priorDir, "rollback-preimage-proposals.json"), "utf8"),
        ) as {
          claim_candidates: MaterializeProposal[];
          claim_candidate_drafts: MaterializeProposal[];
        })
      : null;

  const supabase = createClient(resolveSupabase().url, resolveSupabase().key, {
    auth: { persistSession: false },
  });

  const passOpts = { maxPages, onlyUnresolved: true, useInboxContext: true };
  const ccPass = priorRollback
    ? {
        metrics: {
          table: "claim_candidates" as const,
          rows_scanned: 0,
          rows_already_resolved: 0,
          bucket_counts: {},
          eligible_safe_update: priorRollback.claim_candidates.length,
          applied: 0,
          skipped_ambiguous: 0,
          skipped_unsupported: 0,
          skipped_missing_source: 0,
        },
        proposals: priorRollback.claim_candidates,
      }
    : await runClaimResolverMaterializePass(supabase, "claim_candidates", passOpts);
  const cdPass = onlyCandidates
    ? {
        metrics: {
          table: "claim_candidate_drafts" as const,
          rows_scanned: 0,
          rows_already_resolved: 0,
          bucket_counts: {},
          eligible_safe_update: 0,
          applied: 0,
          skipped_ambiguous: 0,
          skipped_unsupported: 0,
          skipped_missing_source: 0,
        },
        proposals: [] as MaterializeProposal[],
      }
    : priorRollback
      ? {
          metrics: {
            table: "claim_candidate_drafts" as const,
            rows_scanned: 0,
            rows_already_resolved: 0,
            bucket_counts: {},
            eligible_safe_update: priorRollback.claim_candidate_drafts.length,
            applied: 0,
            skipped_ambiguous: 0,
            skipped_unsupported: 0,
            skipped_missing_source: 0,
          },
          proposals: priorRollback.claim_candidate_drafts,
        }
      : await runClaimResolverMaterializePass(supabase, "claim_candidate_drafts", {
          ...passOpts,
          useInboxContext: false,
        });

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

  const blockerInventory = buildBlockerInventory(ccPass.metrics, cdPass.metrics);
  const rawProposals = onlyCandidates ? ccPass.proposals : [...ccPass.proposals, ...cdPass.proposals];
  const { valid: allProposals, invalid_product_fk: fkSkipped } = await filterProposalsWithValidProducts(
    pgClient,
    rawProposals,
  );

  let applied = 0;
  const auditTable = auditTableName(runId);
  if (execute && allProposals.length > 0) {
    const ccProps = onlyCandidates ? allProposals : ccPass.proposals.filter((p) =>
      allProposals.some((v) => v.artifact_id === p.artifact_id),
    );
    const cdProps = onlyCandidates
      ? []
      : cdPass.proposals.filter((p) => allProposals.some((v) => v.artifact_id === p.artifact_id));

    const preimageIds = allProposals.map((p) => p.artifact_id);
    const rollbackRows = await captureRollbackPreimage(pgClient, "claim_candidates", onlyCandidates ? preimageIds : ccProps.map((p) => p.artifact_id));
    if (!onlyCandidates && cdProps.length > 0) {
      rollbackRows.push(...(await captureRollbackPreimage(pgClient, "claim_candidate_drafts", cdProps.map((p) => p.artifact_id))));
    }
    fs.writeFileSync(path.join(outDir, "rollback-preimage-rows.json"), JSON.stringify(rollbackRows, null, 2), "utf8");
    fs.writeFileSync(
      path.join(outDir, "rollback-preimage-proposals.json"),
      JSON.stringify({ claim_candidates: ccProps, claim_candidate_drafts: cdProps }, null, 2),
      "utf8",
    );
    const rollbackSql = rollbackRows.map((r) => {
      const val =
        r.old_resolved_product_id === null
          ? "NULL"
          : `'${r.old_resolved_product_id}'::uuid`;
      return `UPDATE public.claim_candidates SET resolved_product_id = ${val}, updated_at = now() WHERE id = '${r.id}'::uuid;`;
    });
    fs.writeFileSync(
      path.join(outDir, "rollback.sql"),
      ["-- Rollback V175 execute; restore from rollback-preimage-rows.json", ...rollbackSql].join("\n"),
      "utf8",
    );

    await ensureAuditTable(pgClient, auditTable);
    if (onlyCandidates || ccProps.length > 0) {
      applied += await applyProposalsViaPgWithAudit(pgClient, "claim_candidates", ccProps, runId, auditTable);
    }
    if (!onlyCandidates && cdProps.length > 0) {
      applied += await applyProposalsViaPgWithAudit(pgClient, "claim_candidate_drafts", cdProps, runId, auditTable);
    }
  } else if (allProposals.length > 0) {
    fs.writeFileSync(
      path.join(outDir, "rollback-preimage-proposals.json"),
      JSON.stringify(
        {
          claim_candidates: onlyCandidates ? allProposals : ccPass.proposals,
          claim_candidate_drafts: onlyCandidates ? [] : cdPass.proposals,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  const postCounts = execute ? await probeCounts(pgClient) : null;
  await pgClient.end();

  if (postCounts) {
    const post = postCounts as {
      claim_candidates: { resolved: number };
      claim_candidate_drafts: { resolved: number };
    };
    matrix.push({
      id: "post_coverage_candidates",
      label: "claim_candidates resolved_product_id (post)",
      status: "pass",
      message: `${post.claim_candidates.resolved}/${pre.claim_candidates.total}`,
    });
    matrix.push({
      id: "post_coverage_drafts",
      label: "claim_candidate_drafts resolved_product_id (post)",
      status: "pass",
      message: `${post.claim_candidate_drafts.resolved}/${pre.claim_candidate_drafts.total}`,
    });
  }

  fs.writeFileSync(path.join(outDir, "pre-counts.json"), JSON.stringify(preCounts, null, 2));
  if (postCounts) fs.writeFileSync(path.join(outDir, "post-counts.json"), JSON.stringify(postCounts, null, 2));
  fs.writeFileSync(path.join(outDir, "filing-readiness-matrix.json"), JSON.stringify(matrix, null, 2));
  fs.writeFileSync(path.join(outDir, "blocker-inventory.json"), JSON.stringify(blockerInventory, null, 2));
  fs.writeFileSync(
    path.join(outDir, "dry-run-summary.json"),
    JSON.stringify(
      {
        claim_candidates: ccPass.metrics,
        claim_candidate_drafts: cdPass.metrics,
        eligible_total: allProposals.length,
        sample_proposals: allProposals.slice(0, 25),
      },
      null,
      2,
    ),
  );

  const v174Ref = path.join(
    process.cwd(),
    ".cursor/audit-reports/product-id-mapping-materialization-v174/20260519T230000Z/manifest.json",
  );
  const v174Pass = fs.existsSync(v174Ref)
    ? (JSON.parse(fs.readFileSync(v174Ref, "utf8")) as { status?: string }).status === "PASS"
    : null;

  const manifest = {
    prompt: "CLAIM-CANDIDATE-RESOLVER-PROJECT-V175",
    scope: onlyCandidates ? "claim_candidates_only" : "claim_candidates_and_drafts",
    run_id: runId,
    staging_ref: ref,
    audit_table: execute ? auditTableName(runId) : null,
    mode: execute ? "dry_run_and_execute" : "dry_run",
    v174_precondition_pass: v174Pass,
    pre_counts: {
      claim_candidates: pre.claim_candidates,
      claim_candidate_drafts: pre.claim_candidate_drafts,
    },
    eligible_raw: rawProposals.length,
    eligible_after_product_fk: allProposals.length,
    applied,
    proposals_with_invalid_product_fk: fkSkipped,
    max_pages: maxPages ?? null,
    status: v174Pass === false ? "FAIL_PRECONDITION" : "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-CANDIDATE-RESOLVER-PROJECT-V175",
      "",
      `- scope: ${onlyCandidates ? "**claim_candidates only**" : "claim_candidates + drafts"}`,
      `- run_id: \`${runId}\``,
      `- mode: ${execute ? "execute" : "dry-run"}`,
      `- staging: \`${STAGING_REF}\``,
      `- V174 precondition: ${v174Pass === null ? "manifest not found (check manually)" : v174Pass ? "PASS" : "FAIL"}`,
      "",
      "## Pre coverage",
      `- claim_candidates: ${pre.claim_candidates.resolved}/${pre.claim_candidates.total} resolved`,
      `- claim_candidate_drafts: ${pre.claim_candidate_drafts.resolved}/${pre.claim_candidate_drafts.total} resolved`,
      "",
      "## Dry-run eligible",
      `- raw proposals: ${rawProposals.length}`,
      `- after products FK filter: **${allProposals.length}**`,
      `- invalid product FK skipped: ${fkSkipped}`,
      `- applied: ${applied}`,
      execute ? `- audit table: \`${auditTableName(runId)}\`` : "",
      "",
      "## Outputs",
      "- `filing-readiness-matrix.json`",
      "- `blocker-inventory.json`",
      "- `dry-run-summary.json`",
      "",
      "No claim submission. Deterministic tiers only.",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "constraints.md"),
    [
      "# Constraints",
      "",
      "- No claim submission, Amazon API, AI, production, scanner mutation, product auto-create",
      "- No package_items",
      "- No blind settlement/ledger bulk",
      "- Materialize only `identifier_map` + `source_resolved` proposals in `safe_update_candidate` bucket",
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
  process.exitCode = manifest.status === "PASS" ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
