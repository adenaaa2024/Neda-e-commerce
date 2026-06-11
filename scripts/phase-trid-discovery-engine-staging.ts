/**
 * PHASE-TRID-DISCOVERY-ENGINE (staging)
 *
 *   npx tsx scripts/phase-trid-discovery-engine-staging.ts [--run-id=UTC]
 *   APPROVED_TRID_DISCOVERY_STAGING_APPLY=true npx tsx scripts/phase-trid-discovery-engine-staging.ts --apply
 *
 * Staging only. Anchors every discovered reference on claim_candidates via
 * claim_reference_edges. Dedupe enforced by the candidate natural-key index.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  runReferenceDiscovery,
  type DiscoveryRunResult,
} from "../lib/claims/edges/claim-reference-discovery-engine";
import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-trid-discovery-engine-staging";
const MIGRATION_FILE = "supabase/migrations/20260918120000_trid_discovery_engine_edge_types.sql";

const DISCOVERY_EDGE_TYPES = [
  "order_reference",
  "shipment_scope",
  "ledger_reference",
  "safet_reference",
  "product_link",
  "claim_to_removal",
  "claim_to_shipment",
  "claim_to_reimbursement",
  "claim_to_settlement",
];

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

async function edgeTypeCheckIncludesDiscovery(c: pg.Client): Promise<boolean> {
  const r = await c.query(`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.claim_reference_edges'::regclass
      AND conname = 'claim_reference_edges_edge_type_chk'
  `);
  const def = String(r.rows[0]?.def ?? "");
  return def.includes("order_reference") && def.includes("product_link");
}

async function safetHasOrderId(c: pg.Client): Promise<boolean> {
  const r = await c.query(`
    SELECT COUNT(*)::int AS n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'amazon_safet_claims'
      AND column_name IN ('order_id', 'organization_id', 'id')
  `);
  return Number(r.rows[0]?.n ?? 0) === 3;
}

async function verify(c: pg.Client): Promise<{
  candidate_edges_by_type: Record<string, number>;
  candidate_edges_total: number;
  duplicate_candidate_edges: number;
  references_distinct: number;
  coverage: {
    candidates_total: number;
    with_any_edge: number;
    with_discovery_edge: number;
    with_product_link: number;
    with_shipment_scope: number;
    with_financial_link: number;
  };
}> {
  const byType = await c.query(`
    SELECT edge_type, COUNT(*)::int AS n
    FROM public.claim_reference_edges
    WHERE candidate_id IS NOT NULL
    GROUP BY 1 ORDER BY n DESC
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
  const refs = await c.query(`
    SELECT COUNT(DISTINCT (reference_kind, reference_value))::int AS n
    FROM public.claim_reference_edges
    WHERE candidate_id IS NOT NULL AND reference_value IS NOT NULL
  `);
  const typeList = DISCOVERY_EDGE_TYPES.map((t) => `'${t}'`).join(", ");
  const cov = await c.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.claim_candidates) AS candidates_total,
      COUNT(DISTINCT candidate_id)::int AS with_any_edge,
      COUNT(DISTINCT candidate_id) FILTER (WHERE edge_type IN (${typeList}))::int AS with_discovery_edge,
      COUNT(DISTINCT candidate_id) FILTER (WHERE edge_type = 'product_link')::int AS with_product_link,
      COUNT(DISTINCT candidate_id) FILTER (WHERE edge_type IN ('shipment_scope', 'claim_to_shipment'))::int AS with_shipment_scope,
      COUNT(DISTINCT candidate_id) FILTER (WHERE edge_type IN ('financial_reference', 'resolves', 'claim_to_reimbursement', 'claim_to_settlement'))::int AS with_financial_link
    FROM public.claim_reference_edges
    WHERE candidate_id IS NOT NULL
  `);
  const cv = cov.rows[0] as Record<string, number>;
  return {
    candidate_edges_by_type: Object.fromEntries(
      (byType.rows as Array<{ edge_type: string; n: number }>).map((r) => [r.edge_type, r.n]),
    ),
    candidate_edges_total: (byType.rows as Array<{ n: number }>).reduce((s, r) => s + Number(r.n), 0),
    duplicate_candidate_edges: Number(dupes.rows[0]?.n ?? 0),
    references_distinct: Number(refs.rows[0]?.n ?? 0),
    coverage: {
      candidates_total: Number(cv.candidates_total),
      with_any_edge: Number(cv.with_any_edge),
      with_discovery_edge: Number(cv.with_discovery_edge),
      with_product_link: Number(cv.with_product_link),
      with_shipment_scope: Number(cv.with_shipment_scope),
      with_financial_link: Number(cv.with_financial_link),
    },
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
    return { ok: true, output: out.slice(-1500) };
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
  const sources = p.sources_connected as DiscoveryRunResult[];
  const md = `# TRID Discovery Engine (staging)

| Field | Value |
|-------|-------|
| run_id | ${p.run_id} |
| apply_mode | ${p.apply_mode} |
| references_discovered | ${p.references_discovered} |
| new_edges | ${p.new_edges} |
| duplicate_edges | ${p.duplicate_edges} |
| SAFE_FOR_CLAIM_DISCOVERY | ${p.SAFE_FOR_CLAIM_DISCOVERY} |
| build_result | ${p.build_result} |

## Sources connected

| Source | Edge type | Edges | Note |
|--------|-----------|------:|------|
${sources.map((s) => `| ${s.source} | ${s.edge_type} | ${s.edges} | ${s.unavailable ?? ""} |`).join("\n")}

## Claim candidate coverage

\`\`\`json
${JSON.stringify(p.claim_candidate_coverage, null, 2)}
\`\`\`

## Blockers

${((p.blockers as string[]) ?? []).map((b) => `- ${b}`).join("\n") || "- none"}
`;
  fs.writeFileSync(path.join(outDir, "summary.md"), md);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const apply = hasFlag("--apply");
  const outDir = path.join(OUT_BASE, runId);
  const blockers: string[] = [];

  if (apply && process.env.APPROVED_TRID_DISCOVERY_STAGING_APPLY !== "true") {
    throw new Error("BLOCKED: set APPROVED_TRID_DISCOVERY_STAGING_APPLY=true to run --apply on staging");
  }
  const stagingRef = getStagingProjectRef();
  if (stagingRef !== STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ref ${STAGING_REF}, got ${stagingRef}`);
  }

  const c = await connectPg();

  // 1) DDL — discovery edge types (apply mode only; idempotent).
  let typesPresent = await edgeTypeCheckIncludesDiscovery(c);
  if (apply && !typesPresent) {
    const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION_FILE), "utf8");
    await c.query(sql);
    typesPresent = await edgeTypeCheckIncludesDiscovery(c);
    console.log(JSON.stringify({ phase: "ddl_apply", migration: MIGRATION_FILE, ok: typesPresent }));
  }
  if (!typesPresent && !apply) {
    blockers.push("discovery edge types not in CHECK yet (dry-run) — apply runs migration 20260918120000");
  }

  // 2) Discovery run.
  const safetOk = await safetHasOrderId(c);
  const results = await runReferenceDiscovery(
    async (sql) => {
      const r = await c.query(sql);
      return { rowCount: r.rowCount, rows: r.rows as Array<Record<string, unknown>> };
    },
    { apply: apply && typesPresent, safetHasOrderId: safetOk },
  );
  console.log(JSON.stringify({ phase: apply ? "discovery_apply" : "discovery_dry_run", results }));

  // 3) Verify.
  const verification = await verify(c);
  await c.end();

  if (verification.duplicate_candidate_edges > 0) {
    blockers.push(`${verification.duplicate_candidate_edges} duplicate candidate edges found`);
  }

  // 4) Build.
  const build = runBuild();
  if (!build.ok) blockers.push("npm run build failed");

  const newEdges = results.reduce((s, r) => s + r.edges, 0);
  const cov = verification.coverage;
  const coverage = {
    ...cov,
    discovery_coverage_pct: cov.candidates_total
      ? Math.round((cov.with_discovery_edge / cov.candidates_total) * 1000) / 10
      : 0,
    any_edge_coverage_pct: cov.candidates_total
      ? Math.round((cov.with_any_edge / cov.candidates_total) * 1000) / 10
      : 0,
  };

  const safe =
    apply && typesPresent && verification.duplicate_candidate_edges === 0 && build.ok && blockers.length === 0
      ? "yes"
      : "no";

  const payload: Record<string, unknown> = {
    phase: "TRID-DISCOVERY-ENGINE",
    run_id: runId,
    staging_ref: STAGING_REF,
    apply_mode: apply,
    sources_connected: results,
    sources_connected_count: results.length,
    references_discovered: verification.references_distinct,
    new_edges: newEdges,
    duplicate_edges: verification.duplicate_candidate_edges,
    candidate_edges_by_type: verification.candidate_edges_by_type,
    candidate_edges_total: verification.candidate_edges_total,
    claim_candidate_coverage: coverage,
    build_result: build.ok ? "PASS" : "FAIL",
    build_output_tail: build.output,
    SAFE_FOR_CLAIM_DISCOVERY: safe,
    blockers,
    claims_submitted: "none",
    new_pool_tables: "none",
  };

  writeReport(outDir, payload);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
