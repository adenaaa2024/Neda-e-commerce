/**
 * CLAIM-EVIDENCE-ENRICHMENT-EXECUTE-V194 — Governed edge INSERT (returns/removals cohort only).
 *
 *   npx tsx scripts/claim-evidence-enrichment-execute-v194-staging.ts --run-id=<id>
 *   npx tsx scripts/claim-evidence-enrichment-execute-v194-staging.ts --run-id=<id> --execute --max-drafts=50
 *
 * Prerequisite: V193 dry-run PASS; claim-evidence-04 + V194 operator approvals.
 * Excludes amazon_removal_shipments cohort (loader extended in lib only).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  assertClaimEvidence04StagingUrl,
  isClaimEvidence04WriteApproved,
} from "../lib/claim-evidence-persist-approval";
import { persistClaimEvidence04ForDraft } from "../lib/claim-evidence-persist";
import { fetchDraftRow, type ClaimEvidenceDraftRow } from "../lib/claim-evidence-preview";
import { loadAndBuildReferenceCandidatesForDraft } from "../lib/claim-reference-candidates";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/claim-evidence-enrichment-execute-v194";
const V194_APPROVAL_REL = ".cursor/operator-approvals/claim-evidence-enrichment-execute-v194-approval.md";
const V193_RUN = "20260525T220000Z";
const COHORT_SOURCES = ["amazon_returns", "amazon_removals"] as const;

type DraftRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  source_table: string;
  source_row_id: string;
  sku: string | null;
};

type PersistOutcome =
  | { status: "eligible"; preview_edge_count: number; edges_inserted: number; generation_id: string | null }
  | { status: "skipped_no_edges" }
  | { status: "error"; message: string };

type RollbackEntry = {
  draft_id: string;
  organization_id: string;
  generation_id: string | null;
  edge_ids_before: string[];
  edge_ids_after: string[];
  lineage_ids_after: string[];
};

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

function sampleArg(): number {
  const a = process.argv.find((x) => x.startsWith("--sample="));
  if (!a) return 120;
  const n = Number(a.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 120;
}

function maxDraftsArg(): number | null {
  const a = process.argv.find((x) => x.startsWith("--max-drafts="));
  if (!a) return null;
  const n = Number(a.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : null;
}

function v194ApprovalOk(): boolean {
  const p = path.join(process.cwd(), V194_APPROVAL_REL);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return /APPROVED_TO_RUN_STAGING[\s\S]*?\|\s*`?true`?\s*\|/i.test(text);
}

function toDraftRow(r: DraftRow): ClaimEvidenceDraftRow {
  return {
    id: r.id,
    organization_id: r.organization_id,
    store_id: r.store_id,
    source_table: r.source_table,
    source_row_id: r.source_row_id,
    sku: r.sku,
  };
}

async function loadCohortCounts(client: pg.Client): Promise<Record<string, unknown>> {
  const total = await client.query(
    `
    SELECT COUNT(*)::bigint AS n
    FROM public.claim_candidate_drafts d
    WHERE d.resolved_product_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = d.resolved_product_id)
      AND NOT EXISTS (SELECT 1 FROM public.claim_reference_edges e WHERE e.draft_id = d.id)
      AND d.source_table = ANY($1::text[])
  `,
    [COHORT_SOURCES],
  );

  const bySource = await client.query(
    `
    SELECT d.source_table, COUNT(*)::bigint AS n
    FROM public.claim_candidate_drafts d
    WHERE d.resolved_product_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = d.resolved_product_id)
      AND NOT EXISTS (SELECT 1 FROM public.claim_reference_edges e WHERE e.draft_id = d.id)
      AND d.source_table = ANY($1::text[])
    GROUP BY d.source_table ORDER BY n DESC
  `,
    [COHORT_SOURCES],
  );

  return {
    cohort_total: Number(total.rows[0]?.n ?? 0),
    by_source_table: bySource.rows,
  };
}

async function loadCohortDrafts(client: pg.Client, limit: number | null): Promise<DraftRow[]> {
  const sql =
    limit != null
      ? `
    SELECT d.id::text, d.organization_id::text, d.store_id::text, d.source_table, d.source_row_id::text, d.sku
    FROM public.claim_candidate_drafts d
    WHERE d.resolved_product_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = d.resolved_product_id)
      AND NOT EXISTS (SELECT 1 FROM public.claim_reference_edges e WHERE e.draft_id = d.id)
      AND d.source_table = ANY($1::text[])
    ORDER BY md5(d.id::text)
    LIMIT $2
  `
      : `
    SELECT d.id::text, d.organization_id::text, d.store_id::text, d.source_table, d.source_row_id::text, d.sku
    FROM public.claim_candidate_drafts d
    WHERE d.resolved_product_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = d.resolved_product_id)
      AND NOT EXISTS (SELECT 1 FROM public.claim_reference_edges e WHERE e.draft_id = d.id)
      AND d.source_table = ANY($1::text[])
    ORDER BY md5(d.id::text)
  `;
  const params = limit != null ? [COHORT_SOURCES, limit] : [COHORT_SOURCES];
  const res = await client.query(sql, params);
  return res.rows as DraftRow[];
}

async function edgeIdsForDraft(
  client: SupabaseClient,
  orgId: string,
  draftId: string,
): Promise<string[]> {
  const { data, error } = await client
    .from("claim_reference_edges")
    .select("id")
    .eq("organization_id", orgId)
    .eq("draft_id", draftId);
  if (error) throw new Error(`edge preimage: ${error.message}`);
  return (data ?? []).map((r) => String((r as { id: string }).id));
}

async function lineageIdsForGeneration(
  client: SupabaseClient,
  orgId: string,
  generationId: string,
): Promise<string[]> {
  const { data, error } = await client
    .from("claim_evidence_lineage_events")
    .select("id")
    .eq("organization_id", orgId)
    .eq("generation_id", generationId);
  if (error) throw new Error(`lineage preimage: ${error.message}`);
  return (data ?? []).map((r) => String((r as { id: string }).id));
}

async function dryRunPersist(
  supabase: SupabaseClient,
  draft: ClaimEvidenceDraftRow,
): Promise<PersistOutcome> {
  try {
    const result = await persistClaimEvidence04ForDraft(supabase, draft, {
      organizationId: draft.organization_id,
      draftId: draft.id,
      dryRun: true,
    });
    if (result.preview_edge_count === 0) return { status: "skipped_no_edges" };
    return {
      status: "eligible",
      preview_edge_count: result.preview_edge_count,
      edges_inserted: result.edges_inserted,
      generation_id: result.generation_id,
    };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

async function executePersist(
  supabase: SupabaseClient,
  draft: ClaimEvidenceDraftRow,
): Promise<{ outcome: PersistOutcome; rollback: RollbackEntry }> {
  const before = await edgeIdsForDraft(supabase, draft.organization_id, draft.id);
  try {
    const result = await persistClaimEvidence04ForDraft(supabase, draft, {
      organizationId: draft.organization_id,
      draftId: draft.id,
      dryRun: false,
    });
    const after = await edgeIdsForDraft(supabase, draft.organization_id, draft.id);
    const lineageAfter =
      result.generation_id != null
        ? await lineageIdsForGeneration(supabase, draft.organization_id, result.generation_id)
        : [];
    const outcome: PersistOutcome =
      result.preview_edge_count === 0
        ? { status: "skipped_no_edges" }
        : {
            status: "eligible",
            preview_edge_count: result.preview_edge_count,
            edges_inserted: result.edges_inserted,
            generation_id: result.generation_id,
          };
    return {
      outcome,
      rollback: {
        draft_id: draft.id,
        organization_id: draft.organization_id,
        generation_id: result.generation_id,
        edge_ids_before: before,
        edge_ids_after: after,
        lineage_ids_after: lineageAfter,
      },
    };
  } catch (e) {
    return {
      outcome: { status: "error", message: e instanceof Error ? e.message : String(e) },
      rollback: {
        draft_id: draft.id,
        organization_id: draft.organization_id,
        generation_id: null,
        edge_ids_before: before,
        edge_ids_after: await edgeIdsForDraft(supabase, draft.organization_id, draft.id),
        lineage_ids_after: [],
      },
    };
  }
}

function writeRollbackSql(outDir: string, entries: RollbackEntry[]): void {
  const lines = [
    "-- V194 rollback: remove claim-evidence-04 generations inserted by execute run",
    "BEGIN;",
  ];
  for (const e of entries) {
    if (!e.generation_id) continue;
    const newEdgeIds = e.edge_ids_after.filter((id) => !e.edge_ids_before.includes(id));
    for (const id of newEdgeIds) {
      lines.push(`DELETE FROM public.claim_reference_edges WHERE id = '${id}'::uuid;`);
    }
    for (const id of e.lineage_ids_after) {
      lines.push(`DELETE FROM public.claim_evidence_lineage_events WHERE id = '${id}'::uuid;`);
    }
    lines.push(
      `DELETE FROM public.claim_enrichment_generations WHERE id = '${e.generation_id}'::uuid AND organization_id = '${e.organization_id}'::uuid;`,
    );
  }
  lines.push("COMMIT;");
  fs.writeFileSync(path.join(outDir, "rollback.sql"), lines.join("\n"), "utf8");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const sampleSize = sampleArg();
  const maxDrafts = maxDraftsArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging guard failed (ref=${ref})`);
  }

  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!key) throw new Error("Missing STAGING_SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY");
  assertClaimEvidence04StagingUrl(publicUrl);

  if (execute) {
    if (!v194ApprovalOk()) throw new Error(`BLOCKED: missing V194 approval (${V194_APPROVAL_REL})`);
    if (!isClaimEvidence04WriteApproved()) {
      throw new Error("BLOCKED: APPROVED_TO_WRITE_CLAIM_EVIDENCE_04_DEV_STAGING=true not set.");
    }
    if (maxDrafts == null) {
      throw new Error("BLOCKED: --execute requires --max-drafts=<n> (batch cap).");
    }
  }

  const supabase = createClient(publicUrl, key, { auth: { persistSession: false } });
  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const cohortCounts = await loadCohortCounts(pgClient);
  const sampleDrafts = await loadCohortDrafts(pgClient, sampleSize);
  await pgClient.end();

  const dryRunStats = {
    eligible: 0,
    skipped_no_edges: 0,
    error: 0,
    preview_edges_total: 0,
    edges_inserted_dry: 0,
  };
  const dryRunSamples: Array<Record<string, unknown>> = [];
  const tridSampleStats: Record<string, number> = {};

  for (const row of sampleDrafts) {
    const draft = toDraftRow(row);
    const trid = await loadAndBuildReferenceCandidatesForDraft(supabase, draft, { limit: 40 });
    tridSampleStats[trid.outcome] = (tridSampleStats[trid.outcome] ?? 0) + 1;

    const outcome = await dryRunPersist(supabase, draft);
    if (outcome.status === "eligible") {
      dryRunStats.eligible++;
      dryRunStats.preview_edges_total += outcome.preview_edge_count;
      dryRunStats.edges_inserted_dry += outcome.edges_inserted;
    } else if (outcome.status === "skipped_no_edges") {
      dryRunStats.skipped_no_edges++;
    } else {
      dryRunStats.error++;
    }
    if (dryRunSamples.length < 30) {
      dryRunSamples.push({
        draft_id: draft.id,
        source_table: draft.source_table,
        trid_outcome: trid.outcome,
        trid_candidates: trid.candidate_count,
        persist: outcome,
      });
    }
  }

  const executeResults: Array<Record<string, unknown>> = [];
  const rollbackEntries: RollbackEntry[] = [];
  let edgesInsertedLive = 0;
  let draftsPersisted = 0;

  if (execute && maxDrafts != null) {
    const pg2 = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await pg2.connect();
    const batch = await loadCohortDrafts(pg2, maxDrafts);
    await pg2.end();

    for (const row of batch) {
      const draftRow = await fetchDraftRow(supabase, row.organization_id, row.id);
      if (!draftRow) {
        executeResults.push({ draft_id: row.id, status: "error", message: "draft not found" });
        continue;
      }
      const { outcome, rollback } = await executePersist(supabase, draftRow);
      executeResults.push({ draft_id: row.id, source_table: row.source_table, ...outcome });
      if (outcome.status === "eligible") {
        draftsPersisted++;
        edgesInsertedLive += outcome.edges_inserted;
        rollbackEntries.push(rollback);
      }
    }
  }

  const preimage = {
    run_id: runId,
    mode: execute ? "execute" : "dry_run",
    cohort_sources: COHORT_SOURCES,
    cohort_counts: cohortCounts,
    sample_size: sampleDrafts.length,
    sample_dry_run: dryRunStats,
    sample_trid_outcomes: tridSampleStats,
    execute_max_drafts: maxDrafts,
    drafts_persisted: draftsPersisted,
    edges_inserted_live: edgesInsertedLive,
    rollback_entries: rollbackEntries,
    idempotency_key_pattern: "claim-evidence-04:{draft_id}",
  };

  fs.writeFileSync(path.join(outDir, "rollback-preimage.json"), JSON.stringify(preimage, null, 2));
  fs.writeFileSync(path.join(outDir, "dry-run-samples.json"), JSON.stringify(dryRunSamples, null, 2));
  if (executeResults.length > 0) {
    fs.writeFileSync(path.join(outDir, "execute-results.json"), JSON.stringify(executeResults, null, 2));
  }
  if (rollbackEntries.length > 0) {
    writeRollbackSql(outDir, rollbackEntries);
  }

  const manifest = {
    prompt: "CLAIM-EVIDENCE-ENRICHMENT-EXECUTE-V194",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: execute ? "execute" : "dry_run",
    v193_prerequisite_run: V193_RUN,
    v194_approval: v194ApprovalOk(),
    claim_evidence_04_approval: isClaimEvidence04WriteApproved(),
    cohort_sources: COHORT_SOURCES,
    ...cohortCounts,
    sample_dry_run: dryRunStats,
    sample_trid_outcomes: tridSampleStats,
    drafts_persisted: draftsPersisted,
    edges_inserted: edgesInsertedLive,
    execute_max_drafts: maxDrafts,
    status: execute ? (draftsPersisted > 0 ? "EXECUTED" : "EXECUTE_NOOP") : "DRY_RUN_PASS",
    next_prompt: execute ? "CLAIM-EVIDENCE-ENRICHMENT-EXECUTE-V194-BATCH-2" : null,
    secondary_prompt: "AMAZON-REMOVALS-SOURCE-REINGEST-PLAN-V194B",
    output_directory: outDir,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-EVIDENCE-ENRICHMENT-EXECUTE-V194",
      "",
      `- run_id: \`${runId}\``,
      `- mode: **${execute ? "execute" : "dry-run"}**`,
      `- cohort: \`${COHORT_SOURCES.join("`, `")}\` only`,
      "",
      "## Cohort",
      `- FK-valid drafts without edges: **${cohortCounts.cohort_total}**`,
      "",
      `## Sample persist dry-run (${sampleDrafts.length} drafts)`,
      `- eligible: **${dryRunStats.eligible}**`,
      `- skipped (no preview edges): **${dryRunStats.skipped_no_edges}**`,
      `- errors: **${dryRunStats.error}**`,
      `- preview edges (dry): **${dryRunStats.preview_edges_total}**`,
      "",
      execute ? `## Execute batch (--max-drafts=${maxDrafts})` : "## Execute",
      execute
        ? `- drafts persisted: **${draftsPersisted}**`
        : "- not run (add `--execute --max-drafts=N` after operator approval)",
      execute ? `- edges inserted: **${edgesInsertedLive}**` : "",
      "",
      "Rollback: `rollback-preimage.json` + `rollback.sql` (when execute inserts rows).",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
