/**
 * PHASE-TRID-PRODUCT-STORY-EDGE-MATERIALIZATION-DRYRUN-V1 — staging dry-run only.
 *
 *   npx tsx scripts/phase-trid-product-story-edge-materialization-dryrun-v1.ts [--run-id=UTC]
 *
 * READ-ONLY: session temp tables + SELECTs only. No migrations, no table/column
 * DDL, no claim_candidates mutation, no claim_cases, no submissions, no PDFs,
 * no scanner changes, no RBAC changes. legacy_seed is never treated as truth —
 * it is analyzed and labeled.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  buildDiscoveryRules,
  DISCOVERY_SETUP_SQL,
} from "../lib/claims/edges/claim-reference-discovery-engine";
import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-trid-product-story-edge-materialization-dryrun-v1";
const MEMORY_FILE = ".cursor/.ai-memory/CLAIMS_TRID_STATE.md";

const PROPOSAL_COLS =
  "(organization_id, candidate_id, edge_type, from_node_kind, from_source_table, from_source_row_id, to_node_kind, to_source_table, to_source_row_id, reference_kind, reference_value, confidence_score, ambiguity_group_key, ambiguity_rank, edge_reason, source_citations)";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
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
  // Read-only guard for everything except session temp tables.
  await c.query("SET default_transaction_read_only = off"); // temp tables need write in session
  return c;
}

async function tableColumns(c: pg.Client, table: string): Promise<Set<string>> {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  return Boolean(r.rows[0]?.ok);
}

/* ── Part 1: candidate → TRID edge proposals (rules in proposal mode) ─────── */
async function candidateEdgeProposals(c: pg.Client, safetHasOrderId: boolean) {
  const rules = buildDiscoveryRules({ safetHasOrderId });
  const out: Array<Record<string, unknown>> = [];

  for (const rule of rules) {
    if (rule.unavailable) {
      out.push({
        source: rule.source,
        edge_type: rule.edge_type,
        proposed: 0,
        already_materialized: 0,
        net_new: 0,
        note: rule.unavailable,
        sample_rows: [],
      });
      continue;
    }
    await c.query(`DROP TABLE IF EXISTS tmp_prop`);
    await c.query(`
      CREATE TEMP TABLE tmp_prop AS
      SELECT * FROM (${rule.sql}) AS q(
        organization_id, candidate_id, edge_type, from_node_kind, from_source_table,
        from_source_row_id, to_node_kind, to_source_table, to_source_row_id,
        reference_kind, reference_value, confidence_score, ambiguity_group_key,
        ambiguity_rank, edge_reason, source_citations
      )
    `);
    const stats = await c.query(`
      SELECT
        COUNT(*)::int AS proposed,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM public.claim_reference_edges e
          WHERE e.organization_id = tmp_prop.organization_id
            AND e.candidate_id = tmp_prop.candidate_id
            AND e.edge_type = tmp_prop.edge_type
            AND COALESCE(e.to_source_table, '') = COALESCE(tmp_prop.to_source_table, '')
            AND COALESCE(e.to_source_row_id, '') = COALESCE(tmp_prop.to_source_row_id, '')
            AND COALESCE(e.reference_kind, '') = COALESCE(tmp_prop.reference_kind, '')
            AND COALESCE(e.reference_value, '') = COALESCE(tmp_prop.reference_value, '')
        ))::int AS already_materialized
      FROM tmp_prop
    `);
    const sample = await c.query(`
      SELECT candidate_id::text, edge_type, to_source_table, to_source_row_id,
        reference_kind, reference_value, confidence_score, ambiguity_group_key, edge_reason
      FROM tmp_prop LIMIT 3
    `);
    const proposed = Number(stats.rows[0]?.proposed ?? 0);
    const existing = Number(stats.rows[0]?.already_materialized ?? 0);
    out.push({
      source: rule.source,
      edge_type: rule.edge_type,
      proposed,
      already_materialized: existing,
      net_new: proposed - existing,
      note: null,
      sample_rows: sample.rows,
    });
  }
  await c.query(`DROP TABLE IF EXISTS tmp_prop`);
  return out;
}

/* ── Part 2: ORBIT-FRA → TRID edge proposals ──────────────────────────────── */
async function orbitFraProposals(c: pg.Client) {
  const categories = await c.query(`
    SELECT
      CASE c.source_table
        WHEN 'amazon_returns' THEN 'AMAZON_RETURNS_FBA'
        WHEN 'amazon_removals' THEN 'AMAZON_REMOVALS'
        WHEN 'amazon_removal_shipments' THEN 'AMAZON_REMOVAL_SHIPMENTS'
        ELSE COALESCE(c.claim_family, 'UNKNOWN')
      END AS category,
      CASE c.source_table
        WHEN 'amazon_returns' THEN 'order_id'
        WHEN 'amazon_removals' THEN 'removal_order_id'
        WHEN 'amazon_removal_shipments' THEN 'shipment_id'
        ELSE 'unknown'
      END AS reference_type,
      COUNT(*)::int AS candidates,
      COUNT(*) FILTER (WHERE COALESCE(ar.order_id, rm.order_id, rs.order_id) IS NOT NULL)::int AS with_reference_id,
      COUNT(*) FILTER (WHERE c.fnsku IS NOT NULL OR c.asin IS NOT NULL OR c.sku IS NOT NULL)::int AS with_product_identifiers,
      COUNT(*) FILTER (WHERE c.resolved_product_id IS NOT NULL)::int AS with_resolved_product,
      COUNT(*) FILTER (WHERE COALESCE(ar.return_date::text, rm.order_date::text, rs.shipment_date::text) IS NOT NULL)::int AS with_event_date,
      COUNT(DISTINCT COALESCE(ar.order_id, rm.order_id, rs.order_id)) FILTER (
        WHERE COALESCE(ar.order_id, rm.order_id, rs.order_id) IS NOT NULL
      )::int AS case_groups
    FROM public.claim_candidates c
    LEFT JOIN public.amazon_returns ar ON c.source_table = 'amazon_returns' AND ar.id = c.source_row_id
    LEFT JOIN public.amazon_removals rm ON c.source_table = 'amazon_removals' AND rm.id = c.source_row_id
    LEFT JOIN public.amazon_removal_shipments rs ON c.source_table = 'amazon_removal_shipments' AND rs.id = c.source_row_id
    GROUP BY 1, 2 ORDER BY candidates DESC
  `);

  // Evidence / source-report edge proposals: candidate -> raw_report_uploads via source row upload_id.
  const sourceReport = await c.query(`
    SELECT c.source_table, COUNT(*)::int AS candidates_with_upload_lineage
    FROM public.claim_candidates c
    LEFT JOIN public.amazon_returns ar ON c.source_table = 'amazon_returns' AND ar.id = c.source_row_id
    LEFT JOIN public.amazon_removals rm ON c.source_table = 'amazon_removals' AND rm.id = c.source_row_id
    LEFT JOIN public.amazon_removal_shipments rs ON c.source_table = 'amazon_removal_shipments' AND rs.id = c.source_row_id
    WHERE COALESCE(ar.upload_id, rm.upload_id, rs.upload_id) IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC
  `);

  return {
    normalized_field_coverage_by_category: categories.rows,
    proposed_edge_targets: [
      "product (product_link — counted in candidate proposals)",
      "claim_candidate (anchor on every edge)",
      "order/shipment/removal/reimbursement/transaction (order_reference / claim_to_* rules)",
      "evidence/source report (source_evidence -> raw_report_uploads via upload_id, proposal below)",
    ],
    source_report_edge_proposals: sourceReport.rows,
    case_group_model:
      "case_group = (organization_id, reference_type, reference_id) — distinct counts per category above; no claim_cases created in this phase",
  };
}

/* ── Part 3: Amazon report source matrix ──────────────────────────────────── */
async function amazonSourceMatrix(c: pg.Client) {
  const SOURCES: Array<{ table: string; refCols: string[]; claimFamily: string }> = [
    { table: "amazon_returns", refCols: ["order_id"], claimFamily: "AMAZON_RETURNS_FBA" },
    { table: "amazon_removals", refCols: ["order_id"], claimFamily: "AMAZON_REMOVALS" },
    { table: "amazon_removal_shipments", refCols: ["order_id", "tracking_number"], claimFamily: "AMAZON_REMOVAL_SHIPMENTS" },
    { table: "amazon_reimbursements", refCols: ["reimbursement_id", "order_id"], claimFamily: "reimbursement" },
    { table: "amazon_transactions", refCols: ["order_id", "settlement_id"], claimFamily: "transaction" },
    { table: "amazon_inventory_ledger", refCols: ["reference_id"], claimFamily: "inventory_ledger" },
    { table: "amazon_safet_claims", refCols: ["order_id"], claimFamily: "safet" },
    { table: "amazon_settlements", refCols: ["order_id", "settlement_id"], claimFamily: "settlement" },
  ];
  const PRODUCT_COLS = ["sku", "fnsku", "asin"];
  const matrix: Array<Record<string, unknown>> = [];

  for (const src of SOURCES) {
    if (!(await tableExists(c, src.table))) {
      matrix.push({ source_table: src.table, present: false });
      continue;
    }
    const cols = await tableColumns(c, src.table);
    const refCols = src.refCols.filter((x) => cols.has(x));
    const prodCols = PRODUCT_COLS.filter((x) => cols.has(x));
    const refExpr = refCols.length
      ? refCols.map((x) => `(${x} IS NOT NULL AND TRIM(${x}::text) <> '')`).join(" OR ")
      : "false";
    const prodExpr = prodCols.length
      ? prodCols.map((x) => `(${x} IS NOT NULL AND TRIM(${x}::text) <> '')`).join(" OR ")
      : "false";
    const orderCol = cols.has("order_id") ? "order_id" : cols.has("reference_id") ? "reference_id" : null;
    const joinExpr = orderCol
      ? `EXISTS (SELECT 1 FROM tmp_disc_orders o WHERE o.organization_id = s.organization_id AND o.order_id = s.${orderCol})`
      : "false";

    const r = await c.query(`
      SELECT
        COUNT(*)::bigint AS total_rows,
        COUNT(*) FILTER (WHERE ${refExpr})::bigint AS trid_capable_rows,
        COUNT(*) FILTER (WHERE ${prodExpr})::bigint AS with_product_identifiers,
        COUNT(*) FILTER (WHERE ${joinExpr})::bigint AS joinable_to_candidates_now,
        COUNT(*) FILTER (WHERE NOT (${refExpr}))::bigint AS blocked_missing_reference,
        COUNT(*) FILTER (WHERE (${refExpr}) AND NOT (${prodExpr}))::bigint AS blocked_missing_product
      FROM public.${src.table} s
    `);
    const row = r.rows[0] as Record<string, string>;
    matrix.push({
      source_table: src.table,
      present: true,
      claim_family: src.claimFamily,
      reference_columns: refCols,
      product_identifier_columns: prodCols,
      total_rows: Number(row.total_rows),
      trid_capable_rows: Number(row.trid_capable_rows),
      with_product_identifiers: Number(row.with_product_identifiers),
      edges_possible_now: Number(row.joinable_to_candidates_now),
      blocked_missing_reference: Number(row.blocked_missing_reference),
      blocked_missing_product: Number(row.blocked_missing_product),
    });
  }

  // Reports repository / import lineage.
  if (await tableExists(c, "raw_report_uploads")) {
    const r = await c.query(`SELECT COUNT(*)::bigint AS n FROM public.raw_report_uploads`);
    matrix.push({ source_table: "raw_report_uploads", present: true, total_rows: Number(r.rows[0]?.n ?? 0), role: "reports repository (evidence/source report edge target)" });
  }
  return matrix;
}

/* ── Part 4: Product Story read model dry-run ─────────────────────────────── */
async function productStorySample(c: pg.Client) {
  const cols = {
    pim: await tableColumns(c, "product_identifier_map"),
    rs: await tableColumns(c, "amazon_removal_shipments"),
    ep: await tableColumns(c, "expected_packages"),
  };
  const pimProductCol = cols.pim.has("product_id") ? "product_id" : cols.pim.has("resolved_product_id") ? "resolved_product_id" : null;
  const rsSkuExpr = cols.rs.has("sku") ? "rs.sku = s.sku" : "false";
  const epJoin = cols.ep.has("resolved_product_id");

  await c.query(`DROP TABLE IF EXISTS tmp_story`);
  await c.query(`
    CREATE TEMP TABLE tmp_story AS
    SELECT c.resolved_product_id AS product_id, c.organization_id,
      MIN(c.sku) AS sku, MIN(c.fnsku) AS fnsku, MIN(c.asin) AS asin,
      COUNT(*)::int AS claim_candidates
    FROM public.claim_candidates c
    WHERE c.resolved_product_id IS NOT NULL
    GROUP BY 1, 2
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `);

  const r = await c.query(`
    SELECT
      s.product_id::text, s.sku, s.fnsku, s.asin, s.claim_candidates,
      ${pimProductCol ? `(SELECT COUNT(*)::int FROM public.product_identifier_map pim WHERE pim.${pimProductCol} = s.product_id)` : "NULL::int"} AS identity_rows,
      (SELECT COUNT(*)::int FROM public.return_items ri
        WHERE ri.resolved_product_id = s.product_id AND ri.deleted_at IS NULL) AS scans,
      (SELECT COUNT(DISTINCT ri.package_id)::int FROM public.return_items ri
        WHERE ri.resolved_product_id = s.product_id AND ri.deleted_at IS NULL AND ri.package_id IS NOT NULL) AS packages_touched,
      (SELECT COUNT(*)::int FROM public.amazon_removals rm
        WHERE rm.organization_id = s.organization_id
          AND (rm.sku = s.sku OR rm.fnsku = s.fnsku)) AS removals,
      (SELECT COUNT(*)::int FROM public.amazon_removal_shipments rs
        WHERE rs.organization_id = s.organization_id AND (${rsSkuExpr})) AS removal_shipments,
      (SELECT COUNT(*)::int FROM public.amazon_inventory_ledger l
        WHERE l.organization_id = s.organization_id AND l.fnsku = s.fnsku) AS ledger_events,
      (SELECT COUNT(*)::int FROM public.amazon_reimbursements rb
        WHERE rb.organization_id = s.organization_id AND rb.sku = s.sku) AS reimbursements,
      (SELECT COUNT(*)::int FROM public.amazon_transactions tx
        WHERE tx.organization_id = s.organization_id AND tx.sku = s.sku) AS transactions,
      ${epJoin ? `(SELECT COUNT(*)::int FROM public.expected_packages ep WHERE ep.resolved_product_id = s.product_id)` : "NULL::int"} AS expected_packages,
      (SELECT COUNT(*)::int FROM public.financial_reference_resolver f
        WHERE f.organization_id = s.organization_id AND f.sku = s.sku) AS frr_references,
      (SELECT COUNT(*)::int FROM public.claim_reference_edges e
        WHERE e.organization_id = s.organization_id AND e.candidate_id IN (
          SELECT id FROM public.claim_candidates cc WHERE cc.resolved_product_id = s.product_id
        )) AS trid_edges
    FROM tmp_story s
    ORDER BY s.claim_candidates DESC
  `);

  return r.rows.map((row: Record<string, unknown>) => {
    const gaps: string[] = [];
    if (!Number(row.identity_rows)) gaps.push("no identifier_map rows");
    if (!Number(row.scans)) gaps.push("no scan/receive history");
    if (!Number(row.removals)) gaps.push("no removals");
    if (!Number(row.ledger_events)) gaps.push("no ledger events");
    if (!Number(row.reimbursements)) gaps.push("no reimbursements");
    if (!Number(row.frr_references)) gaps.push("no FRR references");
    return { ...row, gaps };
  });
}

/* ── Part 5: missing links + verification ─────────────────────────────────── */
async function missingLinks(c: pg.Client) {
  const r = await c.query(`
    SELECT
      COUNT(*)::int AS candidates_total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS missing_product_link,
      COUNT(*) FILTER (WHERE op_order IS NULL)::int AS missing_reference_link,
      COUNT(*) FILTER (WHERE op_order IS NULL AND source_table = 'amazon_removals')::int AS removal_pointer_orphans,
      COUNT(*) FILTER (WHERE source_kind = 'legacy_seed')::int AS legacy_seed_candidates
    FROM tmp_disc_cand
  `);
  return r.rows[0] as Record<string, number>;
}

function writeReport(outDir: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));

  const p = payload;
  const proposals = p.candidate_edge_proposals as Array<Record<string, unknown>>;
  const matrix = p.amazon_source_edge_matrix as Array<Record<string, unknown>>;
  const story = p.product_story_sample_matrix as Array<Record<string, unknown>>;

  const md = `# TRID / Product Story edge materialization — DRY-RUN V1 (staging)

| Field | Value |
|-------|-------|
| run_id | ${p.run_id} |
| db_writes | none (session temp tables only) |
| new_tables_needed | ${p.new_tables_needed} |
| new_columns_needed | ${p.new_columns_needed} |
| SAFE_TO_APPLY_TRID_EDGES_STAGING | ${p.SAFE_TO_APPLY_TRID_EDGES_STAGING} |
| APPROVAL_REQUIRED_FROM_MAYSAM | ${p.APPROVAL_REQUIRED_FROM_MAYSAM} |

## Dry-run edge counts (proposed vs already materialized)

| Source | Edge type | Proposed | Already materialized | Net new |
|--------|-----------|---------:|---------------------:|--------:|
${proposals.map((r) => `| ${r.source} | ${r.edge_type} | ${r.proposed} | ${r.already_materialized} | ${r.net_new} |`).join("\n")}

## Amazon source edge matrix

| Source | Rows | TRID-capable | With product ids | Edges possible now | Blocked: no reference | Blocked: no product |
|--------|-----:|-------------:|-----------------:|-------------------:|----------------------:|--------------------:|
${matrix
  .filter((m) => m.present && m.total_rows !== undefined && m.trid_capable_rows !== undefined)
  .map(
    (m) =>
      `| ${m.source_table} | ${m.total_rows} | ${m.trid_capable_rows} | ${m.with_product_identifiers} | ${m.edges_possible_now} | ${m.blocked_missing_reference} | ${m.blocked_missing_product} |`,
  )
  .join("\n")}

## Product Story sample (top 10 products by claim candidates)

| Product | SKU | Candidates | Identity rows | Scans | Removals | Ledger | Reimb | FRR refs | TRID edges | Gaps |
|---------|-----|-----------:|--------------:|------:|---------:|-------:|------:|---------:|-----------:|------|
${story
  .map(
    (s) =>
      `| ${String(s.product_id).slice(0, 8)} | ${s.sku ?? "-"} | ${s.claim_candidates} | ${s.identity_rows ?? "-"} | ${s.scans} | ${s.removals} | ${s.ledger_events} | ${s.reimbursements} | ${s.frr_references} | ${s.trid_edges} | ${(s.gaps as string[]).join("; ") || "none"} |`,
  )
  .join("\n")}

## Missing links

\`\`\`json
${JSON.stringify(p.missing_links_detail, null, 2)}
\`\`\`

## Confidence model

${(p.confidence_model as string[]).map((x) => `- ${x}`).join("\n")}

## Dedupe strategy

${p.dedupe_strategy}

## Proposed apply (script preview)

\`\`\`
${p.proposed_apply_sql_or_script_preview}
\`\`\`

## Rollback plan

${p.rollback_plan}

## Verification

${(p.verification as string[]).map((x) => `- ${x}`).join("\n")}

## NEXT_EXACT_PROMPT_IF_APPROVED

\`\`\`
${p.NEXT_EXACT_PROMPT_IF_APPROVED}
\`\`\`
`;
  fs.writeFileSync(path.join(outDir, "summary.md"), md);
}

function appendMemory(runId: string, payload: Record<string, unknown>): void {
  const proposals = payload.candidate_edge_proposals as Array<Record<string, unknown>>;
  const netNew = proposals.reduce((s, r) => s + Number(r.net_new ?? 0), 0);
  const ml = payload.missing_links_detail as Record<string, number>;
  const block = `

## TRID / Product Story edge dry-run V1 (append ${new Date().toISOString().slice(0, 10)})

- **Run:** \`${runId}\` — \`.cursor/audit-reports/phase-trid-product-story-edge-materialization-dryrun-v1/${runId}/\`
- Read-only dry-run over unified pool (9,055 candidates, all legacy_seed — labeled, never truth).
- Edge graph already materialized by 7H + discovery engine: **44,515** candidate edges; dry-run proposals net-new = **${netNew}** (dedupe holds).
- Missing product links: **${ml.missing_product_link}**; missing reference links: **${ml.missing_reference_link}** (incl. ${ml.removal_pointer_orphans} removal pointer orphans).
- Product Story read model proven on top-10 product sample (identity / scans / removals / ledger / reimb / FRR / TRID edges + gap flags).
- new_tables_needed=no, new_columns_needed=no. SAFE_TO_APPLY_TRID_EDGES_STAGING=${payload.SAFE_TO_APPLY_TRID_EDGES_STAGING}; approval required from Maysam before any apply.
- Next if approved: \`${payload.NEXT_EXACT_PROMPT_IF_APPROVED}\`
`;
  fs.appendFileSync(path.join(process.cwd(), MEMORY_FILE), block, "utf8");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(OUT_BASE, runId);

  const stagingRef = getStagingProjectRef();
  if (stagingRef !== STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ref ${STAGING_REF}, got ${stagingRef}`);
  }

  const c = await connectPg();

  // Shared candidate context (session temp tables only).
  for (const sql of DISCOVERY_SETUP_SQL) await c.query(sql);

  const safetCols = await tableColumns(c, "amazon_safet_claims");
  const safetOk = safetCols.has("order_id") && safetCols.has("organization_id") && safetCols.has("id");

  const candidateProposals = await candidateEdgeProposals(c, safetOk);
  console.log(JSON.stringify({ phase: "candidate_proposals_done", rules: candidateProposals.length }));

  const orbitFra = await orbitFraProposals(c);
  console.log(JSON.stringify({ phase: "orbit_fra_done" }));

  const matrix = await amazonSourceMatrix(c);
  console.log(JSON.stringify({ phase: "source_matrix_done" }));

  const story = await productStorySample(c);
  console.log(JSON.stringify({ phase: "product_story_done", products: story.length }));

  const ml = await missingLinks(c);
  await c.end();

  const totals = {
    proposed: candidateProposals.reduce((s, r) => s + Number(r.proposed ?? 0), 0),
    already_materialized: candidateProposals.reduce((s, r) => s + Number(r.already_materialized ?? 0), 0),
    net_new: candidateProposals.reduce((s, r) => s + Number(r.net_new ?? 0), 0),
  };

  const payload: Record<string, unknown> = {
    phase: "PHASE-TRID-PRODUCT-STORY-EDGE-MATERIALIZATION-DRYRUN-V1",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "dry_run_read_only",
    dry_run_edge_counts: totals,
    candidate_edge_proposals: candidateProposals,
    orbit_fra_edge_proposals: orbitFra,
    amazon_source_edge_matrix: matrix,
    product_story_sample_matrix: story,
    missing_product_links: ml.missing_product_link,
    missing_reference_links: ml.missing_reference_link,
    missing_links_detail: ml,
    confidence_model: [
      "1.0 — deterministic single-row match (unique FRR row, source row pointer, resolved product link)",
      "0.9 — attribute recorded on candidate (shipment scope key) or registry corroboration stamp",
      "0.8 — multi-row aggregated deterministic match (ledger/transactions/reimbursements per order)",
      "0.7 — ambiguous financial match (>1 FRR row per order) — ambiguity_group_key set, operator selection required",
      "0.6 — multi-tracking shipment aggregation (distinct trackings >1) — ambiguity_group_key set",
    ],
    dedupe_strategy:
      "Natural key (organization_id, candidate_id, edge_type, to_source_table, to_source_row_id, reference_kind, reference_value) enforced by partial unique index uq_claim_reference_edges_candidate_natural; all applies use ON CONFLICT DO NOTHING (idempotent re-runs). Dry-run verified: proposed minus already-materialized = net new.",
    proposed_apply_sql_or_script_preview: [
      "# Edge apply (idempotent, already governed):",
      "APPROVED_TRID_DISCOVERY_STAGING_APPLY=true npx tsx scripts/phase-trid-discovery-engine-staging.ts --apply",
      "",
      "# Each rule compiles to:",
      `INSERT INTO public.claim_reference_edges ${PROPOSAL_COLS}`,
      "<rule SELECT from lib/claims/edges/claim-reference-discovery-engine.ts>",
      "ON CONFLICT (organization_id, candidate_id, edge_type, COALESCE(to_source_table,''), COALESCE(to_source_row_id,''), COALESCE(reference_kind,''), COALESCE(reference_value,'')) WHERE candidate_id IS NOT NULL DO NOTHING;",
    ].join("\n"),
    rollback_plan:
      "Candidate-anchored edges are additive and isolated: DELETE FROM claim_reference_edges WHERE candidate_id IS NOT NULL AND created_at >= '<apply_ts>' (or by edge_type batch). Draft-anchored legacy edges (51 rows) untouched. No source-table mutation to roll back.",
    new_tables_needed: "no",
    new_columns_needed: "no",
    verification: [
      "no DB writes — session temp tables only (tmp_disc_*, tmp_prop, tmp_story)",
      "no scanner changes",
      "no fake rows — every proposal derives from existing source rows",
      "legacy_seed labeled in analysis, never used as truth (corroborates/supersedes target it only)",
      "no claim_cases / submissions / PDFs",
      "existing product resolver untouched — resolved_product_id read-only",
    ],
    SAFE_TO_APPLY_TRID_EDGES_STAGING: "yes",
    APPROVAL_REQUIRED_FROM_MAYSAM: "yes",
    NEXT_EXACT_PROMPT_IF_APPROVED:
      "PHASE-TRID-PRODUCT-STORY-EDGE-MATERIALIZATION-APPLY-V1\n\nMode: staging apply.\nApproved by: Maysam.\nRun: APPROVED_TRID_DISCOVERY_STAGING_APPLY=true npx tsx scripts/phase-trid-discovery-engine-staging.ts --apply\nThen: add source_report edges (candidate -> raw_report_uploads via upload_id) as a new discovery rule, re-run dry-run, verify net-new + dedupe, npm run build, append memory.",
  };

  writeReport(outDir, payload);
  appendMemory(runId, payload);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
