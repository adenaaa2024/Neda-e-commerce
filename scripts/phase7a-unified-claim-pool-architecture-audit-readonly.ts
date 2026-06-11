/**
 * PHASE-7A-UNIFIED-CLAIM-POOL-ARCHITECTURE-AUDIT (read-only).
 * Inspects claim tables/views and candidate provenance on staging + original.
 * No writes, no DDL, no claim generation.
 *   npx tsx scripts/phase7a-unified-claim-pool-architecture-audit-readonly.ts
 */
import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const TABLES = [
  "claim_candidates",
  "claim_cases",
  "claim_lines",
  "claim_evidence",
  "claim_reference_edges",
  "claim_candidate_source_context",
];

type Env = "staging" | "original";

function urlFor(env: Env): string | null {
  const url =
    env === "staging"
      ? process.env.STAGING_DIRECT_POSTGRES_URL?.trim()
      : process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();
  return url || null;
}

async function connect(env: Env): Promise<pg.Client | null> {
  const url = urlFor(env);
  if (!url) return null;
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '60s'");
  await c.query("SET default_transaction_read_only = on");
  return c;
}

async function tableInfo(c: pg.Client, table: string) {
  const exists = await c.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${table}`]);
  if (exists.rows[0]?.e !== true) return { exists: false };
  const cols = await c.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  const count = await c.query(`SELECT COUNT(*)::bigint AS n FROM public.${table}`);
  return {
    exists: true,
    row_count: Number(count.rows[0]?.n ?? 0),
    columns: cols.rows.map((r) => `${r.column_name}:${r.data_type}`),
  };
}

async function groupBy(c: pg.Client, table: string, col: string, limit = 30) {
  try {
    const r = await c.query(
      `SELECT COALESCE(${col}::text,'<null>') AS k, COUNT(*)::bigint AS n
       FROM public.${table} GROUP BY 1 ORDER BY n DESC LIMIT ${limit}`,
    );
    return r.rows.map((row) => ({ value: row.k, count: Number(row.n) }));
  } catch (e) {
    return { error: String((e as Error).message) };
  }
}

async function hasColumn(c: pg.Client, table: string, col: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, col],
  );
  return r.rows.length > 0;
}

async function auditEnv(env: Env) {
  const c = await connect(env);
  if (!c) return { env, skipped: "no connection string" };

  const out: Record<string, unknown> = { env };

  const tables: Record<string, unknown> = {};
  for (const t of TABLES) tables[t] = await tableInfo(c, t);
  out.tables = tables;

  // v_claim_* views
  const views = await c.query(
    `SELECT table_name FROM information_schema.views
     WHERE table_schema='public' AND table_name LIKE 'v\\_claim%' ESCAPE '\\' ORDER BY 1`,
  );
  out.v_claim_views = views.rows.map((r) => r.table_name);

  // claim_candidates provenance
  const ccInfo = tables["claim_candidates"] as { exists: boolean };
  if (ccInfo?.exists) {
    const breakdowns: Record<string, unknown> = {};
    for (const col of [
      "source",
      "source_type",
      "intake_source",
      "status",
      "claim_type",
      "candidate_type",
      "origin",
      "created_by",
    ]) {
      if (await hasColumn(c, "claim_candidates", col)) {
        breakdowns[col] = await groupBy(c, "claim_candidates", col);
      }
    }
    out.claim_candidates_breakdowns = breakdowns;

    // creation time clustering — detect bulk auto-generation
    const created = await c.query(
      `SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::bigint AS n
       FROM public.claim_candidates GROUP BY 1 ORDER BY n DESC LIMIT 12`,
    );
    out.claim_candidates_created_clusters = created.rows.map((r) => ({
      day: String(r.day),
      count: Number(r.n),
    }));

    // largest same-minute bursts (auto-generation signature)
    const burst = await c.query(
      `SELECT date_trunc('minute', created_at) AS minute, COUNT(*)::bigint AS n
       FROM public.claim_candidates GROUP BY 1 ORDER BY n DESC LIMIT 5`,
    );
    out.claim_candidates_minute_bursts = burst.rows.map((r) => ({
      minute: String(r.minute),
      count: Number(r.n),
    }));
  }

  // claim_cases provenance
  const caseInfo = tables["claim_cases"] as { exists: boolean };
  if (caseInfo?.exists) {
    const breakdowns: Record<string, unknown> = {};
    for (const col of ["source", "status", "claim_type", "case_type", "intake_source"]) {
      if (await hasColumn(c, "claim_cases", col)) {
        breakdowns[col] = await groupBy(c, "claim_cases", col);
      }
    }
    out.claim_cases_breakdowns = breakdowns;
  }

  // claim_reference_edges shape
  const edgeInfo = tables["claim_reference_edges"] as { exists: boolean };
  if (edgeInfo?.exists) {
    const breakdowns: Record<string, unknown> = {};
    for (const col of ["edge_type", "ref_type", "source_table", "target_table", "relation"]) {
      if (await hasColumn(c, "claim_reference_edges", col)) {
        breakdowns[col] = await groupBy(c, "claim_reference_edges", col);
      }
    }
    out.claim_reference_edges_breakdowns = breakdowns;
  }

  // claim_evidence shape
  const evInfo = tables["claim_evidence"] as { exists: boolean };
  if (evInfo?.exists) {
    const breakdowns: Record<string, unknown> = {};
    for (const col of ["evidence_type", "kind", "source"]) {
      if (await hasColumn(c, "claim_evidence", col)) {
        breakdowns[col] = await groupBy(c, "claim_evidence", col);
      }
    }
    out.claim_evidence_breakdowns = breakdowns;
  }

  // source context table
  const ctxInfo = tables["claim_candidate_source_context"] as { exists: boolean };
  if (ctxInfo?.exists) {
    const breakdowns: Record<string, unknown> = {};
    for (const col of ["source", "source_table", "context_type"]) {
      if (await hasColumn(c, "claim_candidate_source_context", col)) {
        breakdowns[col] = await groupBy(c, "claim_candidate_source_context", col);
      }
    }
    out.claim_candidate_source_context_breakdowns = breakdowns;
  }

  // related source tables that may feed the pool
  const related: Record<string, unknown> = {};
  for (const t of [
    "amazon_removal_orders",
    "amazon_removal_shipments",
    "reimbursements",
    "settlement_transactions",
    "inventory_ledger_events",
    "trid_references",
    "file_reference_registry",
    "safet_claims",
  ]) {
    const exists = await c.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${t}`]);
    if (exists.rows[0]?.e === true) {
      const count = await c.query(`SELECT COUNT(*)::bigint AS n FROM public.${t}`);
      related[t] = Number(count.rows[0]?.n ?? 0);
    }
  }
  out.related_source_tables = related;

  await c.end();
  return out;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const staging = await auditEnv("staging");
  const original = await auditEnv("original");
  console.log(JSON.stringify({ staging, original }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
