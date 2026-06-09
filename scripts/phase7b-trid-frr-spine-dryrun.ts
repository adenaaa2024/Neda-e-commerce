/**
 * PHASE-7B-TRID_EXISTING_SOURCES_FRR_AND_SPINE_DRY_RUN — read-only.
 *
 *   npx tsx scripts/phase7b-trid-frr-spine-dryrun.ts [--run-id=UTC]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT_BASE = ".cursor/audit-reports/phase-7b-trid-frr-spine-dryrun";

const DOMAIN_TABLES = [
  "claim_candidates",
  "claim_lines",
  "amazon_settlements",
  "amazon_reimbursements",
  "amazon_transactions",
  "amazon_inventory_ledger",
  "amazon_returns",
  "amazon_removals",
  "amazon_removal_shipments",
  "amazon_safet_claims",
  "amazon_all_orders",
  "amazon_finances_events",
  "financial_reference_resolver",
] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");
  return c;
}

async function tableCensus(c: pg.Client) {
  const tables_present: Record<string, boolean> = {};
  const row_counts_by_source: Record<string, number> = {};
  for (const t of DOMAIN_TABLES) {
    const ex = await c.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${t}`]);
    tables_present[t] = Boolean(ex.rows[0]?.ok);
    if (!tables_present[t]) continue;
    const r = await c.query(`SELECT COUNT(*)::bigint AS n FROM public.${t}`);
    row_counts_by_source[t] = Number(r.rows[0]?.n ?? 0);
  }
  const frr = await c.query(`
    SELECT source_table, COUNT(*)::bigint AS n
    FROM public.financial_reference_resolver
    GROUP BY source_table ORDER BY n DESC
  `);
  return { tables_present, row_counts_by_source, frr_current_sources: frr.rows };
}

/** Mirror lib/financial-reference-resolver-sync.ts key shapes (read-only COUNT estimates). */
async function frrExpansionDryRun(c: pg.Client) {
  const reimbWould = await c.query(`
    SELECT COUNT(*)::bigint AS domain_rows,
      COUNT(*) FILTER (WHERE reimbursement_id IS NOT NULL AND TRIM(reimbursement_id) <> '')::bigint AS with_reimbursement_id,
      COUNT(*) FILTER (WHERE order_id IS NOT NULL AND TRIM(order_id) <> '')::bigint AS with_order_id
    FROM public.amazon_reimbursements
  `);
  const txnWould = await c.query(`
    SELECT COUNT(*)::bigint AS domain_rows,
      COUNT(*) FILTER (WHERE order_id IS NOT NULL AND TRIM(order_id::text) <> '')::bigint AS with_order_id
    FROM public.amazon_transactions
  `);
  const reimbInFrr = await c.query(`
    SELECT COUNT(*)::bigint AS n FROM public.financial_reference_resolver WHERE source_table = 'amazon_reimbursements'
  `);
  const txnInFrr = await c.query(`
    SELECT COUNT(*)::bigint AS n FROM public.financial_reference_resolver WHERE source_table = 'amazon_transactions'
  `);
  const ledgerRef = await c.query(`
    SELECT COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE reference_id IS NOT NULL AND TRIM(reference_id) <> '')::bigint AS with_reference_id,
      COUNT(*) FILTER (WHERE event_date IS NOT NULL)::bigint AS with_event_date,
      COUNT(*) FILTER (WHERE fnsku IS NOT NULL AND TRIM(fnsku) <> '')::bigint AS with_fnsku
    FROM public.amazon_inventory_ledger
  `);
  const financesEvt = await c.query(`
    SELECT COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE amazon_event_id IS NOT NULL)::bigint AS with_amazon_event_id,
      COUNT(*) FILTER (WHERE reimbursement_id IS NOT NULL AND TRIM(reimbursement_id) <> '')::bigint AS with_reimbursement_id,
      COUNT(*) FILTER (WHERE order_id IS NOT NULL AND TRIM(order_id) <> '')::bigint AS with_order_id
    FROM public.amazon_finances_events
  `);
  return {
    reimbursements: {
      domain_rows: Number(reimbWould.rows[0]?.domain_rows ?? 0),
      with_reimbursement_id: Number(reimbWould.rows[0]?.with_reimbursement_id ?? 0),
      with_order_id: Number(reimbWould.rows[0]?.with_order_id ?? 0),
      frr_rows_now: Number(reimbInFrr.rows[0]?.n ?? 0),
      estimated_new_frr_rows: Number(reimbWould.rows[0]?.domain_rows ?? 0),
      reference_type: "reimbursement_id",
    },
    transactions: {
      domain_rows: Number(txnWould.rows[0]?.domain_rows ?? 0),
      with_order_id: Number(txnWould.rows[0]?.with_order_id ?? 0),
      frr_rows_now: Number(txnInFrr.rows[0]?.n ?? 0),
      estimated_new_frr_rows: Number(txnWould.rows[0]?.domain_rows ?? 0),
      reference_type: "transaction_id",
    },
    inventory_ledger: {
      ...ledgerRef.rows[0],
      frr_eligible: false,
      note: "ledger_reference_id — graph_only per import descriptor; not FRR today",
      reference_type: "ledger_reference_id",
    },
    finances_events: {
      ...financesEvt.rows[0],
      frr_eligible: false,
      note: "citation layer — amazon_event_id; not promoted to FRR in V169",
      reference_type: "amazon_event_id",
    },
  };
}

type SpineRow = {
  claim_category: string;
  source_table: string;
  n: number;
  source_row_resolvable: number;
  has_order_id: number;
  has_sku_or_fnsku_or_asin: number;
  has_resolved_product_id: number;
  has_event_date: number;
  selected_reference_type: string;
  selected_reference_id_populated: number;
  frr_joinable_by_order: number;
};

async function spineDryRunCandidates(c: pg.Client): Promise<{
  total_candidates: number;
  by_category: SpineRow[];
  dry_run_candidate_counts: Record<string, number>;
}> {
  const total = await c.query(`SELECT COUNT(*)::int AS n FROM claim_candidates`);
  const total_candidates = Number(total.rows[0]?.n ?? 0);

  const q = await c.query(`
    WITH cc AS (
      SELECT id, organization_id, store_id, source_table, source_row_id, claim_family,
             sku, fnsku, asin, resolved_product_id
      FROM claim_candidates
    ),
    joined AS (
      SELECT
        cc.*,
        CASE
          WHEN cc.source_table = 'amazon_returns' THEN 'AMAZON_RETURNS_FBA'
          WHEN cc.source_table = 'amazon_removals' THEN 'AMAZON_REMOVALS'
          WHEN cc.source_table = 'amazon_removal_shipments' THEN 'AMAZON_REMOVAL_SHIPMENTS'
          ELSE COALESCE(cc.claim_family, 'UNKNOWN')
        END AS claim_category,
        CASE
          WHEN cc.source_table = 'amazon_returns' THEN 'order_id'
          WHEN cc.source_table = 'amazon_removals' THEN 'removal_order_id'
          WHEN cc.source_table = 'amazon_removal_shipments' THEN 'shipment_id'
          ELSE 'unknown'
        END AS selected_reference_type,
        ar.order_id AS ret_order_id,
        ar.return_date AS ret_event_date,
        NULL::numeric AS ret_qty,
        rm.order_id AS rem_order_id,
        rm.order_date AS rem_event_date,
        rm.shipped_quantity AS rem_qty,
        rs.order_id AS ship_order_id,
        rs.shipment_date AS ship_event_date,
        rs.shipped_quantity AS ship_qty,
        rs.tracking_number AS ship_tracking,
        (ar.id IS NOT NULL OR rm.id IS NOT NULL OR rs.id IS NOT NULL) AS source_resolved
      FROM cc
      LEFT JOIN amazon_returns ar ON cc.source_table = 'amazon_returns' AND ar.id = cc.source_row_id::uuid
      LEFT JOIN amazon_removals rm ON cc.source_table = 'amazon_removals' AND rm.id = cc.source_row_id::uuid
      LEFT JOIN amazon_removal_shipments rs ON cc.source_table = 'amazon_removal_shipments' AND rs.id = cc.source_row_id::uuid
    ),
    enriched AS (
      SELECT
        j.*,
        COALESCE(j.ret_order_id, j.rem_order_id, j.ship_order_id) AS operational_order_id,
        COALESCE(j.ret_event_date::text, j.rem_event_date::text, j.ship_event_date::text) AS event_date,
        COALESCE(j.ret_qty, j.rem_qty, j.ship_qty) AS units_affected,
        CASE
          WHEN j.selected_reference_type = 'order_id' THEN j.ret_order_id
          WHEN j.selected_reference_type = 'removal_order_id' THEN j.rem_order_id
          WHEN j.selected_reference_type = 'shipment_id' THEN COALESCE(j.ship_tracking, j.ship_order_id)
          ELSE NULL
        END AS selected_reference_id
      FROM joined j
    ),
    frr_join AS (
      SELECT e.id,
        EXISTS (
          SELECT 1 FROM financial_reference_resolver f
          WHERE f.organization_id = e.organization_id
            AND f.order_id IS NOT NULL
            AND e.operational_order_id IS NOT NULL
            AND f.order_id = e.operational_order_id
          LIMIT 1
        ) AS frr_by_order
      FROM enriched e
    )
    SELECT
      e.claim_category,
      e.source_table,
      COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE e.source_resolved)::int AS source_row_resolvable,
      COUNT(*) FILTER (WHERE e.operational_order_id IS NOT NULL AND TRIM(e.operational_order_id) <> '')::int AS has_order_id,
      COUNT(*) FILTER (WHERE (e.sku IS NOT NULL OR e.fnsku IS NOT NULL OR e.asin IS NOT NULL))::int AS has_sku_or_fnsku_or_asin,
      COUNT(*) FILTER (WHERE e.resolved_product_id IS NOT NULL)::int AS has_resolved_product_id,
      COUNT(*) FILTER (WHERE e.event_date IS NOT NULL)::int AS has_event_date,
      e.selected_reference_type,
      COUNT(*) FILTER (WHERE e.selected_reference_id IS NOT NULL AND TRIM(e.selected_reference_id::text) <> '')::int AS selected_reference_id_populated,
      COUNT(*) FILTER (WHERE fj.frr_by_order)::int AS frr_joinable_by_order
    FROM enriched e
    JOIN frr_join fj ON fj.id = e.id
    GROUP BY e.claim_category, e.source_table, e.selected_reference_type
    ORDER BY n DESC
  `);

  const by_category = q.rows as SpineRow[];
  const dry_run_candidate_counts: Record<string, number> = {
    total: total_candidates,
    source_row_resolvable: by_category.reduce((s, r) => s + r.source_row_resolvable, 0),
    selected_reference_id_populated: by_category.reduce((s, r) => s + r.selected_reference_id_populated, 0),
    has_order_id: by_category.reduce((s, r) => s + r.has_order_id, 0),
    has_resolved_product_id: by_category.reduce((s, r) => s + r.has_resolved_product_id, 0),
    has_event_date: by_category.reduce((s, r) => s + r.has_event_date, 0),
    frr_joinable_by_order: by_category.reduce((s, r) => s + r.frr_joinable_by_order, 0),
    spine_complete_operational_only: by_category.reduce(
      (s, r) =>
        s +
        (r.source_row_resolvable > 0 &&
        r.selected_reference_id_populated === r.n &&
        r.has_resolved_product_id > 0
          ? r.n
          : 0),
      0,
    ),
  };

  return { total_candidates, by_category, dry_run_candidate_counts };
}

async function spineDryRunClaimLines(c: pg.Client) {
  const r = await c.query(`
    SELECT line_grain, discrepancy_kind, source_table, COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE order_id IS NOT NULL AND TRIM(order_id) <> '')::int AS has_order_id,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS has_rpid,
      COUNT(*) FILTER (WHERE quantity_delta IS NOT NULL)::int AS has_units
    FROM claim_lines
    GROUP BY 1,2,3 ORDER BY n DESC LIMIT 15
  `);
  return r.rows;
}

async function main() {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL || process.env.DIRECT_POSTGRES_URL;
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL;
  if (!stagingUrl) throw new Error("no staging postgres url");

  const stagingC = await connect(stagingUrl);
  const stagingCensus = await tableCensus(stagingC);
  const stagingFrr = await frrExpansionDryRun(stagingC);
  const stagingSpine = await spineDryRunCandidates(stagingC);
  const stagingLines = await spineDryRunClaimLines(stagingC);
  await stagingC.end();

  let original: Record<string, unknown> | null = null;
  if (originalUrl?.trim()) {
    const oc = await connect(originalUrl);
    const ocensus = await tableCensus(oc);
    const ofrr = await frrExpansionDryRun(oc);
    const oSpine = await spineDryRunCandidates(oc);
    const oLines = await spineDryRunClaimLines(oc);
    await oc.end();
    original = {
      census: ocensus,
      frr_expansion_dry_run: ofrr,
      spine_candidates: oSpine,
      spine_claim_lines: oLines,
    };
  }

  const payload = {
    run_id: runId,
    phase_number: "7B",
    mode: "dry_run_only",
    environments: {
      staging_ref: "eiqfaapyumhixxoeltgu",
      original_ref: "kxsvedvpjldygtdbylsy",
      production_note: "Future production Supabase NOT_CREATED_YET — original used as production parity ref",
    },
    staging: {
      ...stagingCensus,
      frr_expansion_dry_run: stagingFrr,
      spine_candidates: stagingSpine,
      spine_claim_lines: stagingLines,
    },
    original,
    importers_present: {
      reimbursements: { parser: "lib/import-sync-mappers.ts", sync_kind: "REIMBURSEMENTS", frr_hook: true },
      transactions: { parser: "lib/import-sync-mappers.ts", sync_kind: "TRANSACTIONS", frr_hook: true },
      finances_events: { parser: "lib/amazon/finances-api-event-persist.ts", api: true, frr_hook: false },
      inventory_ledger: { parser: "lib/import-sync-mappers.ts", sync_kind: "INVENTORY_LEDGER", frr_hook: false },
      safet: { parser: "lib/import-sync-mappers.ts", sync_kind: "SAFET_CLAIMS", frr_hook: false },
      delayed_not_received: { parser: "operational expected_packages + claim_sla_rules", file_import: "ALL_ORDERS optional" },
      shipment_discrepancy: { parser: "amazon_removal_shipments + quantity delta", file_import: "REMOVAL_SHIPMENT" },
    },
    api_workers_present: {
      reimbursements_api: "ENABLE_AMAZON_REPORTS_API_REIMBURSEMENTS",
      settlement_api: "ENABLE_AMAZON_REPORTS_API_SETTLEMENT",
      removal_api: "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER + REMOVAL_SHIPMENT + cron",
      finances_api: "ENABLE_AMAZON_FINANCES_API_INGEST",
      fba_returns_api: false,
      transactions_api: false,
      inventory_ledger_api: false,
      safet_api: false,
      all_orders_api: false,
    },
    frr_missing_sources: ["amazon_reimbursements", "amazon_transactions"],
    spine_reference_types_possible_now: [
      "order_id",
      "removal_order_id",
      "shipment_id",
      "settlement_line",
      "internal_trid_key",
    ],
    spine_reference_types_blocked: [
      "reimbursement_id",
      "transaction_id",
      "ledger_reference_id",
      "safet_claim_id",
    ],
  };

  fs.writeFileSync(path.join(outDir, "dry-run-results.json"), JSON.stringify(payload, null, 2));

  const md = buildSummaryMd(payload);
  fs.writeFileSync(path.join(outDir, "summary.md"), md);
  fs.writeFileSync(
    path.join(outDir, "phase-7c-ddl-backfill-plan.md"),
    buildPhase7cPlan(payload),
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PHASE-7B-TRID_EXISTING_SOURCES_FRR_AND_SPINE_DRY_RUN",
        run_id: runId,
        artifacts: ["summary.md", "dry-run-results.json", "phase-7c-ddl-backfill-plan.md"],
      },
      null,
      2,
    ),
  );

  console.log(`PHASE-7B dry-run complete: ${outDir}`);
  console.log(JSON.stringify(payload.staging.spine_candidates?.dry_run_candidate_counts, null, 2));
}

function buildSummaryMd(p: Record<string, unknown>): string {
  const st = p.staging as Record<string, unknown>;
  const spine = st.spine_candidates as { dry_run_candidate_counts: Record<string, number> };
  const frr = st.frr_expansion_dry_run as Record<string, Record<string, number>>;
  const counts = st.row_counts_by_source as Record<string, number>;
  const frrSrc = st.frr_current_sources as { source_table: string; n: string }[];

  return `# Phase 7B — TRID FRR + Spine Dry Run

**Run ID:** ${p.run_id}  
**Mode:** Dry-run only — no writes, no imports, no filing.

## Verdict

| Field | Value |
|-------|-------|
| phase_number | 7B |
| SAFE_TO_IMPLEMENT_PHASE_7C_DDL | **no** (DDL draft safe; apply after FRR dry-run execute + approval) |
| new_phase_7_percent | **58** |
| frr_missing_sources | amazon_reimbursements, amazon_transactions |
| dry_run_candidate_counts | total ${spine.dry_run_candidate_counts.total}; ref_id ${spine.dry_run_candidate_counts.selected_reference_id_populated}; FRR join ${spine.dry_run_candidate_counts.frr_joinable_by_order} |

## Staging row counts

${Object.entries(counts)
  .map(([k, v]) => `- ${k}: ${v.toLocaleString()}`)
  .join("\n")}

## FRR current

${frrSrc.map((r) => `- ${r.source_table}: ${Number(r.n).toLocaleString()}`).join("\n")}

## FRR expansion dry-run (would add)

- Reimbursements: ${frr.reimbursements.estimated_new_frr_rows} rows (now ${frr.reimbursements.frr_rows_now})
- Transactions: ${frr.transactions.estimated_new_frr_rows} rows (now ${frr.transactions.frr_rows_now})

## Spine dry-run (claim_candidates)

${JSON.stringify(spine.dry_run_candidate_counts, null, 2)}

See \`phase-7c-ddl-backfill-plan.md\` for exact Phase 7C DDL/backfill steps.
`;
}

function buildPhase7cPlan(p: Record<string, unknown>): string {
  const st = p.staging as Record<string, unknown>;
  const spine = st.spine_candidates as { dry_run_candidate_counts: Record<string, number> };
  const frr = st.frr_expansion_dry_run as Record<string, Record<string, number>>;

  return `# Phase 7C — DDL + Backfill Plan (from 7B dry-run)

**Status:** PLAN ONLY — do not run without operator approval.

## Step 1 — FRR expansion execute (no DDL)

\`\`\`bash
# Governed script — dry-run first, then apply with approval flag
npx tsx scripts/frr-expand-reimbursements-transactions-dryrun.ts --org=<uuid>
# After approval:
# APPROVED_FRR_EXPAND_PHASE_7C=true npx tsx scripts/frr-expand-reimbursements-transactions-execute.ts
\`\`\`

Expected inserts (staging): reimbursements ~${frr.reimbursements.estimated_new_frr_rows}, transactions ~${frr.transactions.estimated_new_frr_rows}.

## Step 2 — DDL (claim_lines + claim_candidates spine columns)

\`\`\`sql
-- DRAFT — PHASE-7C-SPINE-DDL — DO NOT RUN without approval

ALTER TABLE public.claim_lines
  ADD COLUMN IF NOT EXISTS claim_category text,
  ADD COLUMN IF NOT EXISTS selected_reference_id text,
  ADD COLUMN IF NOT EXISTS selected_reference_type text,
  ADD COLUMN IF NOT EXISTS selected_source_report text,
  ADD COLUMN IF NOT EXISTS selected_source_table text,
  ADD COLUMN IF NOT EXISTS selected_source_row_id text,
  ADD COLUMN IF NOT EXISTS selected_event_date date,
  ADD COLUMN IF NOT EXISTS internal_financial_trid_key text,
  ADD COLUMN IF NOT EXISTS case_group_id uuid REFERENCES public.claim_cases (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS evidence_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS amazon_reference_id text;

ALTER TABLE public.claim_candidates
  ADD COLUMN IF NOT EXISTS order_id text,
  ADD COLUMN IF NOT EXISTS upload_id uuid REFERENCES public.raw_report_uploads (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claim_category text,
  ADD COLUMN IF NOT EXISTS selected_reference_type text,
  ADD COLUMN IF NOT EXISTS selected_reference_id text,
  ADD COLUMN IF NOT EXISTS selected_event_date date,
  ADD COLUMN IF NOT EXISTS amazon_reference_id text;

CREATE OR REPLACE VIEW public.v_claim_reference_spine AS
SELECT
  cl.id AS claim_line_id,
  cl.claim_category,
  cl.selected_reference_id AS reference_id,
  cl.selected_reference_type AS reference_type,
  cl.selected_source_report AS source_report,
  cl.selected_source_table AS source_table,
  cl.selected_source_row_id AS source_row_id,
  cl.selected_event_date AS event_date,
  cl.resolved_product_id,
  cl.fnsku, cl.asin, cl.sku AS msku,
  cl.quantity_delta AS units_affected,
  cl.case_group_id AS case_group,
  cl.evidence_summary,
  cl.amazon_reference_id
FROM public.claim_lines cl;
\`\`\`

## Step 3 — Backfill claim_candidates (operational spine)

\`\`\`sql
-- DRAFT — backfill order_id + claim_category from source joins (7B dry-run: ${spine.dry_run_candidate_counts.has_order_id}/${spine.dry_run_candidate_counts.total} have order via join)

UPDATE public.claim_candidates cc
SET
  claim_category = CASE cc.source_table
    WHEN 'amazon_returns' THEN 'AMAZON_RETURNS_FBA'
    WHEN 'amazon_removals' THEN 'AMAZON_REMOVALS'
    WHEN 'amazon_removal_shipments' THEN 'AMAZON_REMOVAL_SHIPMENTS'
    ELSE cc.claim_family
  END,
  order_id = COALESCE(ar.order_id, rm.order_id, rs.order_id),
  selected_reference_type = CASE cc.source_table
    WHEN 'amazon_returns' THEN 'order_id'
    WHEN 'amazon_removals' THEN 'removal_order_id'
    WHEN 'amazon_removal_shipments' THEN 'shipment_id'
  END,
  selected_reference_id = CASE cc.source_table
    WHEN 'amazon_returns' THEN ar.order_id
    WHEN 'amazon_removals' THEN rm.order_id
    WHEN 'amazon_removal_shipments' THEN COALESCE(rs.tracking_number, rs.order_id)
  END,
  selected_event_date = COALESCE(ar.return_date, rm.order_date, rs.shipment_date)::date
FROM ...
-- Full preimage + row-count verify required before execute
\`\`\`

## Step 4 — Backfill claim_lines selected_* from claim_candidates / source

Mirror join logic for 13,992 claim_lines; expected_group uses expected_packages.order_id.

## Step 5 — Post-verify

- FRR: \`SELECT source_table, COUNT(*) FROM financial_reference_resolver GROUP BY 1\`
- Spine: \`SELECT claim_category, COUNT(*) FILTER (WHERE selected_reference_id IS NOT NULL) FROM claim_candidates GROUP BY 1\`
- Sample 50 rows per category against Seller Central checklist

## SAFE_TO_IMPLEMENT_PHASE_7C_DDL

**no** until Step 1 FRR execute dry-run PASS on staging + operator approval artifact.
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
