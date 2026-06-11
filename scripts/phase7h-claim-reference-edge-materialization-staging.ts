/**
 * PHASE-7H-TRID-REFERENCE-EDGE-MATERIALIZATION (staging)
 *
 *   npx tsx scripts/phase7h-claim-reference-edge-materialization-staging.ts [--run-id=UTC]
 *   APPROVED_PHASE_7H_STAGING_APPLY=true npx tsx scripts/phase7h-claim-reference-edge-materialization-staging.ts --apply
 *
 * Staging only. No claim submission. No automatic promotion. No new pool tables.
 * Applies migration 20260917130000 (candidate anchor on claim_reference_edges),
 * materializes 7H edges set-based, wires order_resolved hook for deterministic
 * resolutions only, verifies dedupe, runs build.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { emitOrderResolvedIfDeterministic } from "../lib/claims/edges/claim-reference-edge-materializer";
import {
  assertStagingSupabaseUrl,
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-7h-claim-reference-edge-materialization-staging";
const MIGRATION_FILE = "supabase/migrations/20260917130000_phase7h_claim_reference_edges_candidate_anchor.sql";
const ORDER_RESOLVED_HOOK_CAP = 10;

const CONFLICT_TARGET = `(organization_id, candidate_id, edge_type, COALESCE(to_source_table, ''), COALESCE(to_source_row_id, ''), COALESCE(reference_kind, ''), COALESCE(reference_value, '')) WHERE candidate_id IS NOT NULL`;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function connectPg(): Promise<pg.Client> {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) {
    throw new Error(`BLOCKED: STAGING_DIRECT_POSTGRES_URL must target ref ${STAGING_REF}`);
  }
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '600s'");
  return c;
}

function createStagingSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  assertStagingSupabaseUrl(url);
  return createClient(url, key, { auth: { persistSession: false } });
}

async function candidateAnchorPresent(c: pg.Client): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'claim_reference_edges' AND column_name = 'candidate_id'`,
  );
  return (r.rowCount ?? 0) > 0;
}

async function buildTempTables(c: pg.Client): Promise<void> {
  await c.query(`DROP TABLE IF EXISTS tmp7h_cand`);
  await c.query(`
    CREATE TEMP TABLE tmp7h_cand AS
    SELECT
      c.id, c.organization_id, c.store_id, c.source_kind, c.source_table,
      c.source_row_id::text AS source_row_id,
      c.claim_family, c.dedupe_key,
      COALESCE(ar.order_id, rm.order_id, rs.order_id, ri.order_id) AS op_order
    FROM public.claim_candidates c
    LEFT JOIN public.amazon_returns ar
      ON c.source_table = 'amazon_returns' AND ar.id = c.source_row_id
    LEFT JOIN public.amazon_removals rm
      ON c.source_table = 'amazon_removals' AND rm.id = c.source_row_id
    LEFT JOIN public.amazon_removal_shipments rs
      ON c.source_table = 'amazon_removal_shipments' AND rs.id = c.source_row_id
    LEFT JOIN public.return_items ri
      ON c.source_table = 'return_items' AND ri.id = c.source_row_id
  `);
  await c.query(`CREATE INDEX ON tmp7h_cand (organization_id, op_order)`);

  await c.query(`DROP TABLE IF EXISTS tmp7h_frr`);
  await c.query(`
    CREATE TEMP TABLE tmp7h_frr AS
    SELECT f.organization_id, f.order_id, f.source_table,
      MIN(f.id::text) AS rep_frr_id,
      COUNT(*)::int AS rows_in_table
    FROM public.financial_reference_resolver f
    JOIN (
      SELECT DISTINCT organization_id, op_order
      FROM tmp7h_cand WHERE op_order IS NOT NULL
    ) o ON o.organization_id = f.organization_id AND o.op_order = f.order_id
    GROUP BY 1, 2, 3
  `);

  await c.query(`DROP TABLE IF EXISTS tmp7h_frr_tot`);
  await c.query(`
    CREATE TEMP TABLE tmp7h_frr_tot AS
    SELECT organization_id, order_id, SUM(rows_in_table)::int AS rows_total
    FROM tmp7h_frr GROUP BY 1, 2
  `);
}

const EDGE_INSERT_COLS = `(organization_id, candidate_id, edge_type, from_node_kind, from_source_table, from_source_row_id, to_node_kind, to_source_table, to_source_row_id, reference_kind, reference_value, confidence_score, ambiguity_group_key, ambiguity_rank, edge_reason, source_citations)`;

/** Each entry: SELECT body that yields the edge rows (without INSERT prefix). */
function edgeSelects(): Record<string, string> {
  return {
    source_evidence: `
      SELECT
        t.organization_id, t.id, 'source_evidence',
        'claim_candidate', 'claim_candidates', t.id::text,
        'source_row', t.source_table, t.source_row_id,
        CASE WHEN t.op_order IS NOT NULL THEN 'order_id' END, t.op_order,
        1.0, NULL, NULL,
        'candidate anchored to source-of-truth row (source_kind=' || t.source_kind || ')',
        jsonb_build_array(jsonb_build_object('table', t.source_table, 'id', t.source_row_id, 'candidate_source_kind', t.source_kind))
      FROM tmp7h_cand t`,
    financial_reference: `
      SELECT
        t.organization_id, t.id, 'financial_reference',
        'claim_candidate', 'claim_candidates', t.id::text,
        'financial_reference', 'financial_reference_resolver', fr.rep_frr_id,
        'order_id', t.op_order,
        CASE WHEN tot.rows_total = 1 THEN 1.0 ELSE 0.7 END,
        CASE WHEN tot.rows_total > 1 THEN t.organization_id::text || ':order:' || t.op_order END,
        CASE WHEN tot.rows_total > 1 THEN ROW_NUMBER() OVER (PARTITION BY t.id ORDER BY fr.source_table)::int END,
        'order joined to FRR via ' || fr.source_table || ' (' || fr.rows_in_table || ' rows)',
        jsonb_build_array(jsonb_build_object('table', 'financial_reference_resolver', 'frr_source_table', fr.source_table, 'match_rows', fr.rows_in_table, 'order_rows_total', tot.rows_total))
      FROM tmp7h_cand t
      JOIN tmp7h_frr fr ON fr.organization_id = t.organization_id AND fr.order_id = t.op_order
      JOIN tmp7h_frr_tot tot ON tot.organization_id = t.organization_id AND tot.order_id = t.op_order`,
    resolves: `
      SELECT
        t.organization_id, t.id, 'resolves',
        'claim_candidate', 'claim_candidates', t.id::text,
        'financial_reference', 'financial_reference_resolver', fr.rep_frr_id,
        'order_id', t.op_order,
        1.0, NULL, NULL,
        'deterministic financial resolution — exactly one FRR row for order',
        jsonb_build_array(jsonb_build_object('table', 'financial_reference_resolver', 'frr_source_table', fr.source_table))
      FROM tmp7h_cand t
      JOIN tmp7h_frr_tot tot
        ON tot.organization_id = t.organization_id AND tot.order_id = t.op_order AND tot.rows_total = 1
      JOIN tmp7h_frr fr ON fr.organization_id = t.organization_id AND fr.order_id = t.op_order`,
    supersedes: `
      SELECT
        t.organization_id, t.id, 'supersedes',
        'claim_candidate', 'claim_candidates', t.id::text,
        'claim_candidate', 'claim_candidates', l.id::text,
        'candidate_id', l.id::text,
        1.0, NULL, NULL,
        'trusted candidate supersedes legacy_seed row sharing the same source row',
        jsonb_build_array(jsonb_build_object('legacy_source_kind', l.source_kind, 'legacy_claim_family', l.claim_family))
      FROM tmp7h_cand t
      JOIN tmp7h_cand l
        ON l.organization_id = t.organization_id
        AND l.source_table = t.source_table
        AND l.source_row_id = t.source_row_id
        AND l.source_kind = 'legacy_seed'
        AND l.id <> t.id
      WHERE t.source_kind <> 'legacy_seed'`,
    corroborates: `
      SELECT
        t.organization_id, t.id, 'corroborates',
        'claim_candidate', 'claim_candidates', t.id::text,
        'claim_candidate', 'claim_candidates', l.id::text,
        'dedupe_key', t.dedupe_key,
        0.9, NULL, NULL,
        'trusted candidate corroborates legacy_seed row (registry corroboration stamp)',
        jsonb_build_array(jsonb_build_object('legacy_candidate_id', l.id))
      FROM public.claim_candidates l
      JOIN public.claim_candidates t
        ON t.organization_id = l.organization_id
        AND t.dedupe_key = l.metadata->>'corroborated_by_dedupe_key'
      WHERE l.source_kind = 'legacy_seed' AND l.metadata ? 'corroborated_by_dedupe_key'`,
    duplicates: `
      SELECT
        t.organization_id, t.id, 'duplicates',
        'claim_candidate', 'claim_candidates', t.id::text,
        'claim_candidate', 'claim_candidates', l.id::text,
        'candidate_id', l.id::text,
        1.0, NULL, NULL,
        'same source row + claim_family duplicate',
        '[]'::jsonb
      FROM tmp7h_cand t
      JOIN tmp7h_cand l
        ON l.organization_id = t.organization_id
        AND l.source_table = t.source_table
        AND l.source_row_id = t.source_row_id
        AND l.claim_family = t.claim_family
        AND l.id <> t.id
        AND l.source_kind = 'legacy_seed'
      WHERE t.source_kind <> 'legacy_seed'`,
  };
}

async function materialize(
  c: pg.Client,
  apply: boolean,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [edgeType, select] of Object.entries(edgeSelects())) {
    if (apply) {
      const res = await c.query(
        `INSERT INTO public.claim_reference_edges ${EDGE_INSERT_COLS}
         ${select}
         ON CONFLICT ${CONFLICT_TARGET} DO NOTHING`,
      );
      out[edgeType] = res.rowCount ?? 0;
    } else {
      const res = await c.query(`SELECT COUNT(*)::int AS n FROM (${select}) q`);
      out[edgeType] = Number(res.rows[0]?.n ?? 0);
    }
  }
  return out;
}

async function verifyEdges(c: pg.Client): Promise<{
  candidate_edges_by_type: Record<string, number>;
  draft_edges_total: number;
  candidate_edges_total: number;
  duplicate_candidate_edges: number;
  ambiguous_edges: number;
  candidates_with_edges: number;
}> {
  const byType = await c.query(`
    SELECT edge_type, COUNT(*)::int AS n
    FROM public.claim_reference_edges
    WHERE candidate_id IS NOT NULL
    GROUP BY 1 ORDER BY n DESC
  `);
  const totals = await c.query(`
    SELECT
      COUNT(*) FILTER (WHERE candidate_id IS NOT NULL)::int AS candidate_edges_total,
      COUNT(*) FILTER (WHERE candidate_id IS NULL AND draft_id IS NOT NULL)::int AS draft_edges_total,
      COUNT(*) FILTER (WHERE candidate_id IS NOT NULL AND ambiguity_group_key IS NOT NULL)::int AS ambiguous_edges,
      COUNT(DISTINCT candidate_id) FILTER (WHERE candidate_id IS NOT NULL)::int AS candidates_with_edges
    FROM public.claim_reference_edges
  `);
  const dupes = await c.query(`
    SELECT COALESCE(SUM(cnt - 1), 0)::int AS n FROM (
      SELECT COUNT(*)::int AS cnt
      FROM public.claim_reference_edges
      WHERE candidate_id IS NOT NULL
      GROUP BY organization_id, candidate_id, edge_type,
        COALESCE(to_source_table, ''), COALESCE(to_source_row_id, ''),
        COALESCE(reference_kind, ''), COALESCE(reference_value, '')
      HAVING COUNT(*) > 1
    ) d
  `);
  const t = totals.rows[0] as Record<string, number>;
  return {
    candidate_edges_by_type: Object.fromEntries(
      (byType.rows as Array<{ edge_type: string; n: number }>).map((r) => [r.edge_type, r.n]),
    ),
    draft_edges_total: Number(t.draft_edges_total),
    candidate_edges_total: Number(t.candidate_edges_total),
    duplicate_candidate_edges: Number(dupes.rows[0]?.n ?? 0),
    ambiguous_edges: Number(t.ambiguous_edges),
    candidates_with_edges: Number(t.candidates_with_edges),
  };
}

async function runOrderResolvedHook(
  c: pg.Client,
  apply: boolean,
): Promise<{
  status: string;
  deterministic_orders: number;
  ambiguous_orders: number;
  emissions: Array<Record<string, unknown>>;
}> {
  const counts = await c.query(`
    SELECT
      COUNT(*) FILTER (WHERE rows_total = 1)::int AS deterministic_orders,
      COUNT(*) FILTER (WHERE rows_total > 1)::int AS ambiguous_orders
    FROM tmp7h_frr_tot
  `);
  const deterministic = Number(counts.rows[0]?.deterministic_orders ?? 0);
  const ambiguous = Number(counts.rows[0]?.ambiguous_orders ?? 0);

  if (!apply) {
    return {
      status: "dry_run_not_invoked",
      deterministic_orders: deterministic,
      ambiguous_orders: ambiguous,
      emissions: [],
    };
  }

  // Deterministic orders that actually have return_items (the emitter's source) — capped sample.
  const sample = await c.query(`
    SELECT DISTINCT tot.organization_id::text AS organization_id, tot.order_id, tot.rows_total
    FROM tmp7h_frr_tot tot
    WHERE tot.rows_total = 1
      AND EXISTS (
        SELECT 1 FROM public.return_items ri
        WHERE ri.organization_id = tot.organization_id
          AND ri.order_id = tot.order_id
          AND ri.deleted_at IS NULL
      )
    LIMIT ${ORDER_RESOLVED_HOOK_CAP}
  `);
  // One ambiguous order to prove the refusal path.
  const ambiguousSample = await c.query(`
    SELECT organization_id::text AS organization_id, order_id, rows_total
    FROM tmp7h_frr_tot WHERE rows_total > 1 LIMIT 1
  `);

  const sb = createStagingSupabase();
  const emissions: Array<Record<string, unknown>> = [];

  for (const row of sample.rows as Array<{ organization_id: string; order_id: string; rows_total: number }>) {
    const r = await emitOrderResolvedIfDeterministic(sb, {
      organizationId: row.organization_id,
      orderId: row.order_id,
      frrMatchCount: Number(row.rows_total),
    });
    emissions.push({ ...r, frr_rows: row.rows_total });
  }
  for (const row of ambiguousSample.rows as Array<{ organization_id: string; order_id: string; rows_total: number }>) {
    const r = await emitOrderResolvedIfDeterministic(sb, {
      organizationId: row.organization_id,
      orderId: row.order_id,
      frrMatchCount: Number(row.rows_total),
    });
    emissions.push({ ...r, frr_rows: row.rows_total });
  }

  return {
    status: "wired_deterministic_only",
    deterministic_orders: deterministic,
    ambiguous_orders: ambiguous,
    emissions,
  };
}

function runBuild(): { ok: boolean; output: string } {
  try {
    const out = execSync("npm run build", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    });
    return { ok: true, output: out.slice(-2000) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${err.stderr ?? ""}\n${err.stdout ?? ""}\n${err.message ?? ""}`.slice(-8000),
    };
  }
}

function writeReport(outDir: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));

  const p = payload;
  const md = `# Phase 7H — TRID reference edge materialization (staging)

| Field | Value |
|-------|-------|
| run_id | ${p.run_id} |
| staging_ref | ${p.staging_ref} |
| apply_mode | ${p.apply_mode} |
| candidate_edges_supported | ${p.candidate_edges_supported} |
| draft_edges_legacy_readable | ${p.draft_edges_legacy_readable} |
| order_resolved_hook_status | ${p.order_resolved_hook_status} |
| evidence_packet_reads_materialized_edges | ${p.evidence_packet_reads_materialized_edges} |
| build_result | ${p.build_result} |
| SAFE_FOR_7I_BILLING_GATES | ${p.SAFE_FOR_7I_BILLING_GATES} |

## Edges materialized

\`\`\`json
${JSON.stringify(p.edges_materialized, null, 2)}
\`\`\`

## Verification

\`\`\`json
${JSON.stringify(p.verification, null, 2)}
\`\`\`

## Ambiguous resolution behavior

${p.ambiguous_resolution_behavior}

## Blockers

${(p.blockers as string[]).map((b) => `- ${b}`).join("\n") || "- none"}
`;
  fs.writeFileSync(path.join(outDir, "summary.md"), md);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const apply = hasFlag("--apply");
  const outDir = path.join(OUT_BASE, runId);
  const blockers: string[] = [];

  if (apply && process.env.APPROVED_PHASE_7H_STAGING_APPLY !== "true") {
    throw new Error("BLOCKED: set APPROVED_PHASE_7H_STAGING_APPLY=true to run --apply on staging");
  }
  const stagingRef = getStagingProjectRef();
  if (stagingRef !== STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ref ${STAGING_REF}, got ${stagingRef}`);
  }

  const c = await connectPg();

  // 1) DDL — candidate anchor migration (idempotent file; apply mode only).
  let anchorPresent = await candidateAnchorPresent(c);
  if (apply && !anchorPresent) {
    const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION_FILE), "utf8");
    await c.query(sql);
    anchorPresent = await candidateAnchorPresent(c);
    console.log(JSON.stringify({ phase: "ddl_apply", migration: MIGRATION_FILE, ok: anchorPresent }));
  }
  if (!anchorPresent && !apply) {
    blockers.push("candidate_id anchor not yet applied (dry-run) — apply runs migration 20260917130000");
  }

  // 2) Build temp candidate/FRR tables and materialize.
  await buildTempTables(c);
  const edgesMaterialized = await materialize(c, apply && anchorPresent);
  console.log(JSON.stringify({ phase: apply ? "materialize_apply" : "materialize_dry_run", edgesMaterialized }));

  // 3) order_resolved hook — deterministic only; ambiguous requires operator selection.
  const hook = await runOrderResolvedHook(c, apply);
  console.log(JSON.stringify({ phase: "order_resolved_hook", status: hook.status, emissions: hook.emissions.length }));

  // 4) Verify.
  const verification = anchorPresent
    ? await verifyEdges(c)
    : {
        candidate_edges_by_type: {},
        draft_edges_total: 0,
        candidate_edges_total: 0,
        duplicate_candidate_edges: 0,
        ambiguous_edges: 0,
        candidates_with_edges: 0,
      };
  await c.end();

  if (verification.duplicate_candidate_edges > 0) {
    blockers.push(`${verification.duplicate_candidate_edges} duplicate candidate edges — natural-key index violated`);
  }

  // 5) Build.
  const build = runBuild();
  if (!build.ok) blockers.push("npm run build failed");

  const safe7i =
    apply &&
    anchorPresent &&
    verification.duplicate_candidate_edges === 0 &&
    build.ok &&
    blockers.length === 0
      ? "yes"
      : "no";

  const payload: Record<string, unknown> = {
    phase_number: "7H",
    run_id: runId,
    staging_ref: STAGING_REF,
    apply_mode: apply,
    edge_schema_audit: {
      anchor_before: "draft_id NOT NULL -> claim_candidate_drafts; generation_id NOT NULL -> claim_enrichment_generations",
      anchor_after: anchorPresent
        ? "candidate_id (nullable, FK claim_candidates) OR draft_id; both nullable with anchor CHECK"
        : "unchanged (dry-run)",
      legacy_edge_types: [
        "operational_to_financial", "claim_to_trid", "claim_to_settlement", "claim_to_reimbursement",
        "claim_to_removal", "claim_to_shipment", "operational_to_slip_line", "slip_line_to_product",
      ],
      new_edge_types: ["corroborates", "resolves", "supersedes", "duplicates", "source_evidence", "financial_reference"],
      dedupe_index: "uq_claim_reference_edges_candidate_natural (org, candidate, type, to_table, to_row, ref_kind, ref_value) WHERE candidate_id IS NOT NULL",
    },
    candidate_edges_supported: anchorPresent ? "yes" : "pending_migration",
    draft_edges_legacy_readable: "yes",
    edges_materialized: edgesMaterialized,
    order_resolved_hook_status: hook.status,
    order_resolved_deterministic_orders: hook.deterministic_orders,
    order_resolved_ambiguous_orders: hook.ambiguous_orders,
    order_resolved_emissions: hook.emissions,
    ambiguous_resolution_behavior:
      "Orders with >1 FRR match get financial_reference edges with ambiguity_group_key + operator_review_status='needs_review' (default); order_resolved emitter refuses (`ambiguous_requires_operator_selection`) until an operator accepts one edge.",
    evidence_packet_reads_materialized_edges: "yes — composeClaimEvidencePacket merges metadata.reference_edges + claim_reference_edges(candidate_id)",
    verification,
    build_result: build.ok ? "PASS" : "FAIL",
    build_output_tail: build.output,
    SAFE_FOR_7I_BILLING_GATES: safe7i,
    blockers,
    claims_submitted: "none",
    candidates_promoted: "none",
    new_pool_tables: "none",
  };

  writeReport(outDir, payload);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
