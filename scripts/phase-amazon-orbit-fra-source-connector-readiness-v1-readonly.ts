/**
 * PHASE-AMAZON-ORBIT-FRA-SOURCE-CONNECTOR-READINESS-V1
 * Read-only audit — no DB writes, no mutations.
 *
 *   npx tsx scripts/phase-amazon-orbit-fra-source-connector-readiness-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-orbit-fra-source-connector-readiness-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

type SourceSpec = {
  key: string;
  label: string;
  table: string | null;
  report_type?: string;
  import_kind: "file" | "api" | "scanner" | "generator" | "planned";
  generator: string | null;
  source_kind: string | null;
  product_cols: string[];
  ref_cols: string[];
  event_date_col: string | null;
  amount_col: string | null;
  cogs_source: string;
  evidence_cols: string[];
};

const SOURCES: SourceSpec[] = [
  {
    key: "orbit_fra_workbook",
    label: "ORBIT/FRA workbook (Fight List XLSX)",
    table: null,
    import_kind: "planned",
    generator: "lib/claims/intake/claim-orbit-fra-generator.ts (live over DB tables; XLSX import planned)",
    source_kind: "orbit_fra",
    product_cols: ["fnsku", "asin", "sku/msku"],
    ref_cols: ["reference_id", "reference_type", "amazon_reference_id"],
    event_date_col: "event_date",
    amount_col: "recovery_value",
    cogs_source: "SellerSnap/product cost (NOT sale price)",
    evidence_cols: ["evidence_summary", "source_report", "case_group", "case_status"],
  },
  {
    key: "scanner_returns",
    label: "Physical return scans (return_items)",
    table: "return_items",
    import_kind: "scanner",
    generator: "scanner_physical_review in claim-intake-generators.ts",
    source_kind: "scanner_physical_review",
    product_cols: ["fnsku", "asin", "sku"],
    ref_cols: ["package_id", "lpn"],
    event_date_col: "received_at",
    amount_col: null,
    cogs_source: "return_items unit value fallback only; SellerSnap not wired",
    evidence_cols: ["notes", "vision_lines", "package_id"],
  },
  {
    key: "fba_customer_returns",
    label: "FBA Customer Returns",
    table: "amazon_returns",
    report_type: "RETURNS",
    import_kind: "file",
    generator: "amazon_return path + discovery",
    source_kind: "amazon_return / delayed_not_received",
    product_cols: ["fnsku", "asin", "sku", "lpn"],
    ref_cols: ["order_id"],
    event_date_col: "return_date",
    amount_col: null,
    cogs_source: "none on row; ORBIT uses cogs_resolver fallback",
    evidence_cols: ["upload_id", "raw_data", "disposition", "reason"],
  },
  {
    key: "inventory_ledger",
    label: "Inventory Ledger",
    table: "amazon_inventory_ledger",
    report_type: "INVENTORY_LEDGER",
    import_kind: "file",
    generator: "inventory_ledger generator",
    source_kind: "inventory_ledger",
    product_cols: ["fnsku", "asin", "sku"],
    ref_cols: ["reference_id"],
    event_date_col: "event_date",
    amount_col: null,
    cogs_source: "SellerSnap not wired; recovery = units × cogs_unit",
    evidence_cols: ["upload_id", "reason_code", "unreconciled_quantity", "raw_data"],
  },
  {
    key: "reimbursements",
    label: "Reimbursements",
    table: "amazon_reimbursements",
    report_type: "REIMBURSEMENTS",
    import_kind: "file",
    generator: "reimbursement generator",
    source_kind: "reimbursement",
    product_cols: ["sku", "fnsku", "asin"],
    ref_cols: ["reimbursement_id", "order_id"],
    event_date_col: "created_at",
    amount_col: "amount_reimbursed",
    cogs_source: "observed amount only; not COGS",
    evidence_cols: ["upload_id", "raw_data"],
  },
  {
    key: "transactions",
    label: "Transactions",
    table: "amazon_transactions",
    report_type: "TRANSACTIONS",
    import_kind: "file",
    generator: "transaction generator",
    source_kind: "transaction",
    product_cols: ["sku"],
    ref_cols: ["order_id", "settlement_id"],
    event_date_col: "posted_date",
    amount_col: "amount",
    cogs_source: "none",
    evidence_cols: ["upload_id", "raw_data"],
  },
  {
    key: "settlements",
    label: "Settlements",
    table: "amazon_settlements",
    report_type: "SETTLEMENT",
    import_kind: "file",
    generator: "settlement generator (claimable filter)",
    source_kind: "settlement",
    product_cols: ["sku"],
    ref_cols: ["order_id", "settlement_id"],
    event_date_col: "posted_date",
    amount_col: "amount_total",
    cogs_source: "none",
    evidence_cols: ["upload_id", "source_file_name", "raw_data"],
  },
  {
    key: "removal_order_detail",
    label: "Removal Order Detail",
    table: "amazon_removals",
    report_type: "REMOVAL_ORDER",
    import_kind: "api",
    generator: "amazon_removal_api generator",
    source_kind: "amazon_removal_api",
    product_cols: ["sku", "fnsku", "asin"],
    ref_cols: ["order_id", "tracking_number"],
    event_date_col: "order_date",
    amount_col: "removal_fee",
    cogs_source: "none on row",
    evidence_cols: ["upload_id", "raw_data"],
  },
  {
    key: "removal_shipment_detail",
    label: "Removal Shipment Detail",
    table: "amazon_removal_shipments",
    report_type: "REMOVAL_SHIPMENT",
    import_kind: "api",
    generator: "amazon_removal_api + shipment_discrepancy",
    source_kind: "amazon_removal_api / shipment_discrepancy",
    product_cols: ["sku", "fnsku", "asin"],
    ref_cols: ["order_id", "tracking_number", "shipment_id"],
    event_date_col: "shipment_date",
    amount_col: null,
    cogs_source: "none",
    evidence_cols: ["upload_id", "carrier", "raw_data"],
  },
  {
    key: "safet",
    label: "SAFE-T",
    table: "amazon_safet_claims",
    report_type: "SAFET",
    import_kind: "file",
    generator: "safet generator",
    source_kind: "safet",
    product_cols: ["asin", "sku"],
    ref_cols: ["safet_claim_id", "order_id"],
    event_date_col: "claim_date",
    amount_col: "total_reimbursement_amount",
    cogs_source: "none",
    evidence_cols: ["upload_id", "claim_reason", "claim_status", "raw_data"],
  },
  {
    key: "reports_repository",
    label: "Reports Repository (raw_report_uploads)",
    table: "raw_report_uploads",
    import_kind: "file",
    generator: "evidence lineage target (source_evidence edges)",
    source_kind: null,
    product_cols: [],
    ref_cols: ["id (upload_id)"],
    event_date_col: "created_at",
    amount_col: null,
    cogs_source: "n/a",
    evidence_cols: ["file_name", "report_type", "metadata"],
  },
  {
    key: "sp_api_product_sync",
    label: "Amazon SP-API / catalog product sync",
    table: "products",
    import_kind: "api",
    generator: "product enrichment / catalog sync (not claim_candidates direct)",
    source_kind: "product_catalog",
    product_cols: ["asin", "fnsku", "seller_sku"],
    ref_cols: [],
    event_date_col: "updated_at",
    amount_col: null,
    cogs_source: "products.cost / product_prices (not SellerSnap)",
    evidence_cols: ["amazon_raw", "pim_image_provenance"],
  },
  {
    key: "sellersnap_cogs",
    label: "SellerSnap / COGS source",
    table: "product_prices",
    import_kind: "planned",
    generator: "ORBIT cogs_resolver (not wired)",
    source_kind: null,
    product_cols: ["sku", "asin via product join"],
    ref_cols: [],
    event_date_col: "observed_at",
    amount_col: "unit_cost / price fields",
    cogs_source: "INTENDED canonical COGS — NOT IMPORTED",
    evidence_cols: [],
  },
  {
    key: "financial_reference_resolver",
    label: "financial_reference_resolver (TRID spine)",
    table: "financial_reference_resolver",
    import_kind: "api",
    generator: "FRR ingest / settlement reconcile",
    source_kind: null,
    product_cols: ["sku", "asin", "fnsku"],
    ref_cols: ["order_id", "settlement_id", "reimbursement_id"],
    event_date_col: "posted_date",
    amount_col: "amount",
    cogs_source: "n/a — observed financial refs",
    evidence_cols: ["source_table", "source_row_id", "confidence_score"],
  },
  {
    key: "product_identifier_map",
    label: "product_identifier_map (linkage spine)",
    table: "product_identifier_map",
    import_kind: "file",
    generator: "resolver for Product Story + candidate linkage",
    source_kind: null,
    product_cols: ["identifier_type", "identifier_value"],
    ref_cols: [],
    event_date_col: "created_at",
    amount_col: null,
    cogs_source: "n/a",
    evidence_cols: ["source_upload_id"],
  },
  {
    key: "claim_reference_edges",
    label: "claim_reference_edges (materialized TRID)",
    table: "claim_reference_edges",
    import_kind: "generator",
    generator: "claim-reference-discovery-engine",
    source_kind: null,
    product_cols: [],
    ref_cols: ["reference_kind", "reference_value"],
    event_date_col: "created_at",
    amount_col: null,
    cogs_source: "n/a",
    evidence_cols: ["source_citations", "edge_reason"],
  },
  {
    key: "claim_candidates",
    label: "claim_candidates (unified pool)",
    table: "claim_candidates",
    import_kind: "generator",
    generator: "claim-generator-registry (10+ generators)",
    source_kind: "multiple",
    product_cols: ["sku", "fnsku", "asin", "resolved_product_id"],
    ref_cols: ["reference_id", "reference_type"],
    event_date_col: "event_date",
    amount_col: "recovery_value",
    cogs_source: "cogs_unit column (sparse)",
    evidence_cols: ["metadata", "source_table", "source_row_id"],
  },
];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  return Boolean(r.rows[0]?.ok);
}

async function tableColumns(c: pg.Client, table: string): Promise<Set<string>> {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function pct(n: number, d: number): number {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

function colExpr(cols: Set<string>, names: string[]): string {
  const present = names.filter((n) => cols.has(n));
  if (!present.length) return "false";
  return present.map((n) => `(${n} IS NOT NULL AND TRIM(${n}::text) <> '')`).join(" OR ");
}

async function auditTableSource(
  c: pg.Client,
  spec: SourceSpec,
  cols: Set<string>,
): Promise<Record<string, unknown>> {
  const table = spec.table!;
  const scopeFilter =
    cols.has("store_id") && cols.has("organization_id")
      ? `organization_id = '${ORG}'::uuid AND store_id = '${STORE}'::uuid`
      : cols.has("organization_id")
        ? `organization_id = '${ORG}'::uuid`
        : "true";

  const prodExpr = colExpr(cols, spec.product_cols.filter((x) => !x.includes("/")));
  const refExpr = colExpr(cols, spec.ref_cols.filter((x) => !x.includes(" ")));
  const eventCol = spec.event_date_col && cols.has(spec.event_date_col) ? spec.event_date_col : null;
  const amountCol = spec.amount_col && cols.has(spec.amount_col) ? spec.amount_col : null;

  const resolvedExpr = cols.has("resolved_product_id")
    ? "COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS with_resolved_product"
    : "0::bigint AS with_resolved_product";

  const r = await c.query(`
    SELECT
      COUNT(*)::bigint AS total_rows,
      COUNT(*) FILTER (WHERE ${prodExpr})::bigint AS with_product_ids,
      COUNT(*) FILTER (WHERE ${refExpr})::bigint AS with_reference_ids,
      COUNT(*) FILTER (WHERE ${prodExpr} AND ${refExpr})::bigint AS candidate_capable_rows,
      COUNT(*) FILTER (WHERE ${refExpr})::bigint AS trid_capable_rows,
      ${resolvedExpr},
      ${eventCol ? `MIN(${eventCol})::text AS min_event, MAX(${eventCol})::text AS max_event` : "NULL::text AS min_event, NULL::text AS max_event"},
      ${amountCol ? `COUNT(*) FILTER (WHERE ${amountCol} IS NOT NULL AND ${amountCol}::numeric <> 0)::bigint AS with_amount` : "0::bigint AS with_amount"},
      MAX(created_at)::text AS last_created
    FROM public.${table}
    WHERE ${scopeFilter}
  `);

  const row = r.rows[0] as Record<string, string>;
  const total = Number(row.total_rows);
  const withProd = Number(row.with_product_ids);
  const withRef = Number(row.with_reference_ids);
  const candidateCapable = Number(row.candidate_capable_rows);
  const tridCapable = Number(row.trid_capable_rows);
  const withResolved = Number(row.with_resolved_product ?? 0);

  let lastImport: Record<string, unknown> | null = null;
  if (spec.report_type && (await tableExists(c, "raw_report_uploads"))) {
    const u = await c.query(
      `SELECT MAX(created_at)::text AS last_upload, COUNT(*)::int AS upload_count,
              MIN(created_at)::text AS first_upload
       FROM public.raw_report_uploads
       WHERE organization_id = $1::uuid AND report_type = $2`,
      [ORG, spec.report_type],
    );
    lastImport = u.rows[0] as Record<string, unknown>;
  }
  if (cols.has("upload_id") && (await tableExists(c, "raw_report_uploads"))) {
    const scopeT =
      cols.has("store_id") && cols.has("organization_id")
        ? `t.organization_id = '${ORG}'::uuid AND t.store_id = '${STORE}'::uuid`
        : cols.has("organization_id")
          ? `t.organization_id = '${ORG}'::uuid`
          : "true";
    const u = await c.query(`
      SELECT MAX(u.created_at)::text AS last_lineage_upload, COUNT(DISTINCT t.upload_id)::int AS distinct_uploads
      FROM public.${table} t
      JOIN public.raw_report_uploads u ON u.id = t.upload_id
      WHERE ${scopeT}
    `);
    lastImport = { ...(lastImport ?? {}), ...(u.rows[0] as object) };
  }

  const blockers: string[] = [];
  if (total === 0) blockers.push("no_rows_in_scope");
  if (!withRef && spec.ref_cols.length) blockers.push("missing_reference_identifiers");
  if (!withProd && spec.product_cols.length) blockers.push("missing_product_identifiers");
  if (spec.cogs_source.includes("NOT") || spec.cogs_source.includes("not wired"))
    blockers.push("cogs_source_not_wired");

  return {
    source_key: spec.key,
    label: spec.label,
    imported: total > 0 ? "yes" : "no",
    table,
    org_store_scope: cols.has("store_id") ? `${ORG}/${STORE}` : ORG,
    row_count: total,
    last_import: lastImport,
    event_date_range: eventCol ? { min: row.min_event, max: row.max_event } : null,
    last_created: row.last_created,
    product_identifiers: {
      available_columns: spec.product_cols.filter((x) => cols.has(x.split("/")[0]!)),
      populated_rows: withProd,
      pct: pct(withProd, total),
    },
    reference_identifiers: {
      available_columns: spec.ref_cols.filter((x) => cols.has(x.split(" ")[0]!)),
      populated_rows: withRef,
      pct: pct(withRef, total),
    },
    event_date_field: eventCol,
    amount_field: amountCol,
    amount_populated_rows: Number(row.with_amount ?? 0),
    cogs_availability: spec.cogs_source,
    evidence_fields: spec.evidence_cols.filter((e) => cols.has(e.split(" ")[0]!)),
    candidate_capable: candidateCapable > 0 ? "yes" : total > 0 ? "partial" : "no",
    candidate_capable_rows: candidateCapable,
    trid_capable: tridCapable > 0 ? "yes" : total > 0 ? "partial" : "no",
    trid_capable_rows: tridCapable,
    product_story_capable:
      withResolved > 0 ? "partial" : withProd > 0 ? "partial" : "no",
    product_story_resolved_rows: withResolved,
    generator: spec.generator,
    source_kind: spec.source_kind,
    api_endpoint_needed: `/api/claims/connectors/sources/${spec.key}`,
    missing_blocker: blockers.join("; ") || null,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url?.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL must target staging");

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");
  await c.query("SET default_transaction_read_only = on");

  const matrix: Record<string, unknown>[] = [];

  for (const spec of SOURCES) {
    if (!spec.table) {
      matrix.push({
        source_key: spec.key,
        label: spec.label,
        imported: "no",
        table: null,
        org_store_scope: ORG,
        row_count: 0,
        product_identifiers: { available_columns: spec.product_cols },
        reference_identifiers: { available_columns: spec.ref_cols },
        event_date_field: spec.event_date_col,
        amount_field: spec.amount_col,
        cogs_availability: spec.cogs_source,
        evidence_fields: spec.evidence_cols,
        candidate_capable: spec.key === "orbit_fra_workbook" ? "partial" : "no",
        trid_capable: spec.key === "financial_reference_resolver" ? "partial" : "no",
        product_story_capable: spec.key === "product_identifier_map" ? "partial" : "no",
        generator: spec.generator,
        source_kind: spec.source_kind,
        api_endpoint_needed: `/api/claims/connectors/sources/${spec.key}`,
        missing_blocker:
          spec.key === "orbit_fra_workbook"
            ? "xlsx_import_not_built; use live generator over DB tables"
            : spec.key === "sellersnap_cogs"
              ? "SellerSnap connector not wired; COGS_MISSING for recovery_value"
              : "not_applicable_or_no_table",
      });
      continue;
    }
    if (!(await tableExists(c, spec.table))) {
      matrix.push({
        source_key: spec.key,
        label: spec.label,
        imported: "no",
        table: spec.table,
        missing_blocker: "table_absent",
      });
      continue;
    }
    const cols = await tableColumns(c, spec.table);
    matrix.push(await auditTableSource(c, spec, cols));
  }

  // claim_candidates breakdown
  const cc = await c.query(`
    SELECT source_kind, source_table, COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE reference_id IS NOT NULL)::int AS with_ref,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS linked,
      COUNT(*) FILTER (WHERE recovery_value IS NOT NULL AND recovery_value > 0)::int AS with_recovery,
      COUNT(*) FILTER (WHERE cogs_unit IS NOT NULL)::int AS with_cogs
    FROM public.claim_candidates
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
      AND source_kind IS DISTINCT FROM 'legacy_seed'
      AND quarantined_at IS NULL AND rejected_at IS NULL
    GROUP BY 1, 2 ORDER BY n DESC
  `, [ORG, STORE]);

  const edges = await c.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(DISTINCT candidate_id)::int AS candidates_with_edges
    FROM public.claim_reference_edges WHERE organization_id = $1::uuid
  `, [ORG]);

  const pim = await c.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(DISTINCT product_id)::int AS distinct_products
    FROM public.product_identifier_map WHERE organization_id = $1::uuid
  `, [ORG]);

  const costGap = await c.query(`
    SELECT
      COUNT(*)::int AS candidates_active,
      COUNT(*) FILTER (WHERE cogs_unit IS NOT NULL)::int AS with_cogs_unit,
      COUNT(*) FILTER (WHERE recovery_value IS NOT NULL AND recovery_value > 0)::int AS with_recovery_value
    FROM public.claim_candidates
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
      AND source_kind IS DISTINCT FROM 'legacy_seed'
      AND quarantined_at IS NULL
  `, [ORG, STORE]);

  await c.end();

  const candidateCapable = matrix.filter((m) => m.candidate_capable === "yes" || m.candidate_capable === "partial");
  const tridCapable = matrix.filter((m) => m.trid_capable === "yes" || m.trid_capable === "partial");
  const storyCapable = matrix.filter((m) => m.product_story_capable === "yes" || m.product_story_capable === "partial");

  const orbitFraContract = {
    required_columns: {
      FNSKU: "claim_candidates.fnsku / source row fnsku",
      ASIN: "claim_candidates.asin / source row asin",
      MSKU: "claim_candidates.sku (merchant sku)",
      "Units Affected": "expected_quantity | actual_quantity | delta_quantity | ORBIT units calc",
      "COGS / Unit": "claim_candidates.cogs_unit — MUST come from SellerSnap/product cost, NOT sale price",
      "Recovery Value": "recovery_value = units_affected × cogs_unit when COGS exists; else COGS_MISSING",
      "Event Date": "claim_candidates.event_date",
      "Reference ID": "claim_candidates.reference_id",
      "Reference Type": "claim_candidates.reference_type",
      "Source Report": "metadata.source_report + source_table lineage → raw_report_uploads",
      "Evidence Summary": "metadata.evidence_summary",
      "Case Group": "(organization_id, reference_type, reference_id) — no claim_cases created",
      "Case Status": "display-only external status in metadata; no submission",
      "Amazon Reference ID": "reference_edges order_id / reimbursement_id / removal_order_id",
    },
    rules: [
      "COGS must come from SellerSnap/product cost source, not sale price",
      "Recovery Value = Units Affected × COGS when COGS exists",
      "If COGS missing → COGS_MISSING / Cost unknown flag on candidate",
      "Reference ID/Type must match category source requirements per ORBIT category map",
      "Do not create case/submission in connector phase",
    ],
    live_generator: "lib/claims/intake/claim-orbit-fra-generator.ts",
    spreadsheet_import: "BLOCKED — hybrid staged via raw_report_uploads; dry-run parser not in repo",
  };

  const amazonApiContract = {
    sp_api_reports: [
      { report: "REMOVAL_ORDER", table: "amazon_removals", automation: "removal_api_sync", status: "live_partial" },
      { report: "REMOVAL_SHIPMENT", table: "amazon_removal_shipments", automation: "removal_api_sync", status: "live_partial" },
      { report: "REIMBURSEMENTS", table: "amazon_reimbursements", automation: "reimbursements_api", status: "partial" },
      { report: "SETTLEMENT", table: "amazon_settlements", automation: "settlement_api", status: "partial" },
      { report: "FINANCES_ARCHIVE", table: "financial_reference_resolver", automation: "finances_archive_api", status: "partial_trid_only" },
    ],
    catalog_product_sync: {
      table: "products",
      path: "product enrichment / SP-API catalog",
      feeds: "claim_candidates indirectly via resolved_product_id + Product Story",
    },
    read_routes_existing: [
      "GET /api/claims/center/sources",
      "GET /api/claims/center/automation-health",
      "GET /api/claims/center/runs",
      "GET /api/claims/intake/settings-status",
    ],
    read_routes_needed: [
      "GET /api/claims/connectors/readiness — source_readiness_matrix aggregate",
      "GET /api/claims/connectors/sources/:key/coverage",
      "GET /api/claims/connectors/cost-gaps",
      "GET /api/claims/connectors/identifier-gaps",
      "GET /api/claims/connectors/trid-coverage",
      "GET /api/claims/connectors/product-story-coverage",
    ],
  };

  const reportFileContract = {
    pipeline: "UniversalImporter → raw_report_uploads → import sync → amazon_* domain tables → generators → claim_candidates",
    report_types_supported: [
      "RETURNS", "INVENTORY_LEDGER", "REIMBURSEMENTS", "TRANSACTIONS", "SETTLEMENT", "SAFET",
      "REMOVAL_ORDER", "REMOVAL_SHIPMENT",
    ],
    evidence_lineage: "upload_id on domain rows → raw_report_uploads (Reports Repository)",
    idempotency: "source_line_hash / org+natural keys per table",
    blockers: [
      "Reimbursement/settlement API schedules disabled on original until operator enable",
      "Inventory ledger unreconciled qty depends on migration columns present",
      "ORBIT XLSX not wired",
    ],
  };

  const missingApiRoutes = amazonApiContract.read_routes_needed;
  const missingImportJobs = [
    "ORBIT-FRA XLSX staged import apply",
    "SellerSnap COGS sync job",
    "Scheduled claim-pool-generation cron (exists but gated)",
    "FBA returns API pull (file-only today)",
    "Inventory ledger API pull (file-only today)",
  ];

  const missingIdentifierGaps = [
    "49.1% overall product linkage — Product Story blocked",
    "Physical return MVP: FNSKU X006OFFM01 no product_identifier_map hit (pilot dry-run)",
    "amazon_returns: fnsku column sparse vs order_id",
    "claim_reference_edges: 0 materialized on staging smoke org",
  ];

  const missingCostGaps = [
    `cogs_unit populated on ${costGap.rows[0]?.with_cogs_unit ?? 0}/${costGap.rows[0]?.candidates_active ?? 0} active candidates`,
    "SellerSnap not wired — ORBIT recovery_value falls back to report amount or COGS_MISSING",
    "product_prices exists but not designated as COGS authority",
  ];

  const closestFirst =
    "scanner_returns (physical_return MVP) — return_items → scanner_physical_review already live with 4 staging candidates; then amazon_returns file import + generator for FBA return family TRID edges";

  const summary = {
    phase: "PHASE-AMAZON-ORBIT-FRA-SOURCE-CONNECTOR-READINESS-V1",
    run_id: rid,
    mode: "read-only",
    staging_ref: STAGING_REF,
    org_id: ORG,
    store_id: STORE,
    source_readiness_matrix: matrix,
    orbit_fra_connector_contract: orbitFraContract,
    amazon_api_connector_contract: amazonApiContract,
    report_file_connector_contract: reportFileContract,
    candidate_capable_sources: candidateCapable.map((m) => m.source_key),
    trid_capable_sources: tridCapable.map((m) => m.source_key),
    product_story_capable_sources: storyCapable.map((m) => m.source_key),
    claim_candidates_by_source: cc.rows,
    claim_reference_edges: edges.rows[0],
    product_identifier_map: pim.rows[0],
    cost_gap_stats: costGap.rows[0],
    missing_api_routes: missingApiRoutes,
    missing_import_jobs: missingImportJobs,
    missing_identifier_gaps: missingIdentifierGaps,
    missing_cost_gaps: missingCostGaps,
    closest_source_to_implement_first: closestFirst,
    SAFE_TO_IMPLEMENT_SOURCE_CONNECTOR_READMODEL: "yes",
    SAFE_TO_IMPLEMENT_SOURCE_CONNECTOR_READMODEL_conditions:
      "Read-only GET routes only; no claim_candidates mutation; no case/submission; Maysam approval for SellerSnap COGS schema if added",
    NEXT_EXACT_PROMPT:
      "PHASE-SOURCE-CONNECTOR-READMODEL-V1 — implement GET /api/claims/connectors/readiness (aggregate matrix from this audit SQL); wire Claim Center /sources page to readiness banner; still read-only",
    blockers: [
      "SellerSnap COGS not wired",
      "claim_reference_edges empty on smoke org",
      "ORBIT XLSX import not built",
      "Product linkage 49.1% blocks full Product Story",
    ],
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

  const md = `# Source connector readiness V1 (read-only)

| Field | Value |
|-------|-------|
| run_id | ${rid} |
| staging_ref | ${STAGING_REF} |
| SAFE_TO_IMPLEMENT_SOURCE_CONNECTOR_READMODEL | **yes** (read-only routes) |

## Source readiness matrix

| Source | Imported | Rows | Candidate | TRID | Product Story | Blocker |
|--------|----------|-----:|-----------|------|---------------|---------|
${matrix
  .map(
    (m) =>
      `| ${m.label ?? m.source_key} | ${m.imported ?? "-"} | ${m.row_count ?? "-"} | ${m.candidate_capable ?? "-"} | ${m.trid_capable ?? "-"} | ${m.product_story_capable ?? "-"} | ${m.missing_blocker ?? "-"} |`,
  )
  .join("\n")}

## Closest source to implement first

${closestFirst}

## Missing API routes

${missingApiRoutes.map((r) => `- \`${r}\``).join("\n")}

## NEXT_EXACT_PROMPT

\`\`\`
${summary.NEXT_EXACT_PROMPT}
\`\`\`
`;
  fs.writeFileSync(path.join(outDir, "readiness-report.md"), md);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
