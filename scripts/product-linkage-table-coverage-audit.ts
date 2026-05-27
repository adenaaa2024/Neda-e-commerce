/**
 * PRODUCT LINKAGE TABLE COVERAGE AUDIT — ALL OPERATIONAL TABLES
 *
 * Read-only staging census. No DB writes.
 *
 *   npx tsx scripts/product-linkage-table-coverage-audit.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/product-linkage-table-coverage-audit";

type NextAction =
  | "no_action"
  | "resolver_read_model"
  | "map_only_backfill"
  | "product_promotion"
  | "sp_api_evidence"
  | "manual_review"
  | "schema_migration_needed";

type NedaDep = "critical" | "secondary" | "none";

type EntitySpec = {
  name: string;
  kind: "table" | "view";
  category: string;
  persist_mode: "persist_resolved" | "persist_legacy_product_id" | "read_model_only" | "aggregate_indirect" | "catalog_spine" | "n/a";
  active_filter_sql: string;
  neda_dependency: NedaDep;
  owner: string;
  notes: string;
};

type CoverageRow = {
  name: string;
  kind: "table" | "view";
  category: string;
  owner: string;
  total_rows: number;
  persisted_product_id: number | null;
  persisted_resolved_product_id: number | null;
  read_layer_resolved: number | null;
  identifier_only_rows: number | null;
  item_name_only_rows: number | null;
  unresolved_rows: number | null;
  ambiguous_rows: number | null;
  persist_mode: string;
  neda_ui_dependency: NedaDep;
  next_action: NextAction;
  linkage_percent: number | null;
  query_errors: string[];
  notes: string;
};

const ENTITY_SPECS: EntitySpec[] = [
  { name: "products", kind: "table", category: "catalog-spine", persist_mode: "catalog_spine", active_filter_sql: "deleted_at IS NULL", neda_dependency: "critical", owner: "PIM", notes: "Canonical spine" },
  { name: "product_identifier_map", kind: "table", category: "catalog-spine", persist_mode: "catalog_spine", active_filter_sql: "deleted_at IS NULL", neda_dependency: "critical", owner: "Governed map", notes: "Identifier bridge" },
  { name: "return_items", kind: "table", category: "item-level", persist_mode: "persist_resolved", active_filter_sql: "deleted_at IS NULL", neda_dependency: "critical", owner: "Returns scanner", notes: "Scanner persist" },
  { name: "expected_packages", kind: "table", category: "item-level", persist_mode: "read_model_only", active_filter_sql: "TRUE", neda_dependency: "critical", owner: "Expected import", notes: "Read-layer map only" },
  { name: "slip_contents", kind: "table", category: "item-level", persist_mode: "persist_resolved", active_filter_sql: "TRUE", neda_dependency: "critical", owner: "Slip import", notes: "OCR/slip lines" },
  { name: "packages", kind: "table", category: "aggregate", persist_mode: "aggregate_indirect", active_filter_sql: "TRUE", neda_dependency: "secondary", owner: "Returns", notes: "Via return_items" },
  { name: "pallets", kind: "table", category: "aggregate", persist_mode: "aggregate_indirect", active_filter_sql: "TRUE", neda_dependency: "secondary", owner: "Returns", notes: "Via packages" },
  { name: "shipment_boxes", kind: "table", category: "aggregate", persist_mode: "aggregate_indirect", active_filter_sql: "TRUE", neda_dependency: "secondary", owner: "Shipment", notes: "Via box_items" },
  { name: "shipment_box_items", kind: "table", category: "item-level", persist_mode: "read_model_only", active_filter_sql: "TRUE", neda_dependency: "secondary", owner: "Shipment scan", notes: "Resolve at submit" },
  { name: "shipment_containers", kind: "table", category: "aggregate", persist_mode: "aggregate_indirect", active_filter_sql: "TRUE", neda_dependency: "none", owner: "Shipment", notes: "Tracking parent" },
  { name: "amazon_amazon_fulfilled_inventory", kind: "table", category: "report-source", persist_mode: "persist_resolved", active_filter_sql: "TRUE", neda_dependency: "secondary", owner: "AFI import", notes: "Inventory spine" },
  { name: "amazon_fba_inventory", kind: "table", category: "report-source", persist_mode: "persist_resolved", active_filter_sql: "TRUE", neda_dependency: "secondary", owner: "FBA import", notes: "E2 promotion source" },
  { name: "amazon_manage_fba_inventory", kind: "table", category: "report-source", persist_mode: "persist_resolved", active_filter_sql: "TRUE", neda_dependency: "secondary", owner: "Manage FBA", notes: "E2 promotion source" },
  { name: "amazon_returns", kind: "table", category: "report-source", persist_mode: "persist_resolved", active_filter_sql: "TRUE", neda_dependency: "secondary", owner: "Returns report", notes: "Claim source" },
  { name: "amazon_settlements", kind: "table", category: "report-source", persist_mode: "read_model_only", active_filter_sql: "TRUE", neda_dependency: "none", owner: "Settlements", notes: "Financial lines" },
  { name: "claim_candidates", kind: "table", category: "claim", persist_mode: "persist_resolved", active_filter_sql: "TRUE", neda_dependency: "secondary", owner: "Claim inbox", notes: "Legacy queue" },
  { name: "claim_candidate_drafts", kind: "table", category: "claim", persist_mode: "persist_resolved", active_filter_sql: "TRUE", neda_dependency: "secondary", owner: "Claim V2", notes: "Draft generator" },
  { name: "claim_evidence_lineage_events", kind: "table", category: "claim", persist_mode: "read_model_only", active_filter_sql: "TRUE", neda_dependency: "none", owner: "Claim evidence", notes: "Lineage audit" },
  { name: "v_scanned_items_counted", kind: "view", category: "view-read-model", persist_mode: "read_model_only", active_filter_sql: "TRUE", neda_dependency: "critical", owner: "Neda scanned", notes: "Scanned aggregate view" },
  { name: "v_inventory_item_status", kind: "view", category: "view-read-model", persist_mode: "read_model_only", active_filter_sql: "TRUE", neda_dependency: "critical", owner: "Neda compare", notes: "Item compare view" },
  { name: "v_inventory_status", kind: "view", category: "view-read-model", persist_mode: "aggregate_indirect", active_filter_sql: "TRUE", neda_dependency: "critical", owner: "Neda package", notes: "Package chips only" },
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

async function tableColumns(client: pg.Client, name: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function colExists(cols: Set<string>, names: string[]): string[] {
  return names.filter((n) => cols.has(n));
}

function buildIdPredicates(cols: Set<string>, alias = "t"): string[] {
  const preds: string[] = [];
  for (const c of ["sku", "fnsku", "asin", "upc", "upc_code", "product_identifier", "seller_sku", "msku", "fulfillment_channel_sku"]) {
    if (cols.has(c)) preds.push(`NULLIF(TRIM(${alias}.${c}), '') IS NOT NULL`);
  }
  return preds;
}

function buildNamePredicates(cols: Set<string>, alias = "t"): string[] {
  const preds: string[] = [];
  for (const c of ["item_name", "product_name", "title", "description"]) {
    if (cols.has(c)) preds.push(`NULLIF(TRIM(${alias}.${c}), '') IS NOT NULL`);
  }
  return preds;
}

async function auditEntity(client: pg.Client, spec: EntitySpec): Promise<CoverageRow> {
  const errors: string[] = [];
  let cols: Set<string>;
  try {
    cols = await tableColumns(client, spec.name);
  } catch (e) {
    return emptyRow(spec, [e instanceof Error ? e.message : String(e)]);
  }
  if (!cols.size) return emptyRow(spec, [`relation ${spec.name} not found`]);

  const hasProductId = cols.has("product_id");
  const hasResolved = cols.has("resolved_product_id");
  const idPreds = buildIdPredicates(cols);
  const namePreds = buildNamePredicates(cols);
  const hasAnyId = idPreds.length > 0;
  const hasAnyName = namePreds.length > 0;

  const filter = spec.active_filter_sql;
  const rel = spec.kind === "view" ? `public.${spec.name}` : `public.${spec.name}`;

  const countSql = (extra: string) =>
    `SELECT COUNT(*)::int AS c FROM ${rel} t WHERE (${filter}) ${extra ? `AND (${extra})` : ""}`;

  async function count(extra: string): Promise<number | null> {
    try {
      const r = await client.query(countSql(extra));
      return Number(r.rows[0]?.c ?? 0);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  const total = await count("");
  let persistedProduct: number | null = null;
  let persistedResolved: number | null = null;
  if (hasProductId) persistedProduct = await count("t.product_id IS NOT NULL");
  if (hasResolved) persistedResolved = await count("t.resolved_product_id IS NOT NULL");

  const hasLink = [
    hasResolved ? "t.resolved_product_id IS NOT NULL" : null,
    hasProductId ? "t.product_id IS NOT NULL" : null,
  ]
    .filter(Boolean)
    .join(" OR ");

  let identifierOnly: number | null = null;
  if (spec.persist_mode !== "catalog_spine" && hasAnyId && hasLink) {
    identifierOnly = await count(`(${idPreds.join(" OR ")}) AND NOT (${hasLink})`);
  } else if (spec.persist_mode !== "catalog_spine" && hasAnyId) {
    identifierOnly = await count(idPreds.join(" OR "));
  }

  let itemNameOnly: number | null = null;
  if (hasAnyName) {
    const noId = hasAnyId ? `NOT (${idPreds.join(" OR ")})` : "TRUE";
    const noLink = hasLink ? `NOT (${hasLink})` : "TRUE";
    itemNameOnly = await count(`(${namePreds.join(" OR ")}) AND ${noId} AND ${noLink}`);
  }

  let readLayer: number | null = null;
  let unresolved: number | null = null;
  let ambiguous: number | null = null;

  if (spec.name === "products") {
    readLayer = total;
    unresolved = 0;
  } else if (spec.name === "product_identifier_map") {
    readLayer = persistedProduct;
    unresolved = await count("t.product_id IS NULL");
  } else if (
    spec.kind === "table" &&
    ["return_items", "expected_packages", "slip_contents"].includes(spec.name) &&
    cols.has("organization_id") &&
    cols.has("store_id")
  ) {
    const rl = await pgMapReadLayer(client, spec.name, cols, filter);
    if (rl.error) errors.push(rl.error);
    else {
      readLayer = rl.read_layer_resolved;
      unresolved = rl.unresolved;
      ambiguous = rl.ambiguous;
    }
  } else if (hasLink) {
    readLayer = Math.max(persistedResolved ?? 0, persistedProduct ?? 0);
    if (total != null && readLayer != null) unresolved = Math.max(0, total - readLayer);
  }

  if (unresolved == null && total != null) {
    const resolved = readLayer ?? Math.max(persistedResolved ?? 0, persistedProduct ?? 0);
    unresolved = Math.max(0, total - resolved);
  }

  const effectiveResolved = readLayer ?? Math.max(persistedResolved ?? 0, persistedProduct ?? 0);
  const linkagePercent =
    total && total > 0 && effectiveResolved != null ? Math.round((effectiveResolved / total) * 1000) / 10 : null;

  const row: CoverageRow = {
    name: spec.name,
    kind: spec.kind,
    category: spec.category,
    owner: spec.owner,
    total_rows: total ?? 0,
    persisted_product_id: persistedProduct,
    persisted_resolved_product_id: persistedResolved,
    read_layer_resolved: readLayer,
    identifier_only_rows: identifierOnly,
    item_name_only_rows: itemNameOnly,
    unresolved_rows: unresolved,
    ambiguous_rows: ambiguous,
    persist_mode: spec.persist_mode,
    neda_ui_dependency: spec.neda_dependency,
    next_action: "manual_review",
    linkage_percent: linkagePercent,
    query_errors: errors,
    notes: spec.notes,
  };
  row.next_action = inferNextAction(row);
  return row;
}

function emptyRow(spec: EntitySpec, errors: string[]): CoverageRow {
  return {
    name: spec.name,
    kind: spec.kind,
    category: spec.category,
    owner: spec.owner,
    total_rows: 0,
    persisted_product_id: null,
    persisted_resolved_product_id: null,
    read_layer_resolved: null,
    identifier_only_rows: null,
    item_name_only_rows: null,
    unresolved_rows: null,
    ambiguous_rows: null,
    persist_mode: spec.persist_mode,
    neda_ui_dependency: spec.neda_dependency,
    next_action: "schema_migration_needed",
    linkage_percent: null,
    query_errors: errors,
    notes: spec.notes,
  };
}

async function pgMapReadLayer(
  client: pg.Client,
  table: string,
  cols: Set<string>,
  filter: string,
): Promise<{ read_layer_resolved: number; unresolved: number; ambiguous: number; error?: string }> {
  const skuExpr = cols.has("sku") ? "NULLIF(TRIM(sku),'')" : "NULL::text";
  const fnskuExpr = cols.has("fnsku") ? "NULLIF(TRIM(fnsku),'')" : "NULL::text";
  const hasProductId = cols.has("product_id");
  const baseSelect = [
    "id",
    "organization_id",
    "store_id",
    `${skuExpr} AS sku`,
    `${fnskuExpr} AS fnsku`,
    cols.has("resolved_product_id") ? "resolved_product_id" : null,
    hasProductId ? "product_id" : null,
  ]
    .filter(Boolean)
    .join(", ");

  const mapSkuCte = cols.has("sku")
    ? `
    map_sku AS (
      SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM base b
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id=b.organization_id AND m.store_id=b.store_id
       AND m.deleted_at IS NULL AND b.sku IS NOT NULL AND (m.seller_sku=b.sku OR m.msku=b.sku)
      GROUP BY b.id
    )`
    : `map_sku AS (SELECT b.id, 0::int AS c FROM base b)`;

  const resolvedCheck = hasProductId
    ? "b.resolved_product_id IS NOT NULL OR b.product_id IS NOT NULL"
    : "b.resolved_product_id IS NOT NULL";

  const sql = `
    WITH base AS (
      SELECT ${baseSelect}
      FROM public.${table} t WHERE (${filter.replace(/\bt\./g, "")})
    ),
    map_fnsku AS (
      SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM base b
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id=b.organization_id AND m.store_id=b.store_id
       AND m.deleted_at IS NULL AND b.fnsku IS NOT NULL AND m.fnsku=b.fnsku
      GROUP BY b.id
    ),
    ${mapSkuCte},
    classified AS (
      SELECT b.id,
        CASE
          WHEN ${resolvedCheck} THEN 'resolved'
          WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'resolved'
          WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM base b
      LEFT JOIN map_fnsku mf ON mf.id=b.id
      LEFT JOIN map_sku ms ON ms.id=b.id
    )
    SELECT
      COUNT(*) FILTER (WHERE bucket='resolved')::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous
    FROM classified`;

  try {
    const r = await client.query(sql);
    const row = r.rows[0] as Record<string, number>;
    return {
      read_layer_resolved: Number(row.read_layer_resolved ?? 0),
      unresolved: Number(row.unresolved ?? 0),
      ambiguous: Number(row.ambiguous ?? 0),
    };
  } catch (e) {
    return {
      read_layer_resolved: 0,
      unresolved: 0,
      ambiguous: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function inferNextAction(r: CoverageRow): NextAction {
  if (r.query_errors.length && r.total_rows === 0) return "schema_migration_needed";
  if (r.persist_mode === "aggregate_indirect" || r.persist_mode === "catalog_spine" || r.name === "v_inventory_status") {
    return "no_action";
  }
  if (r.name === "product_identifier_map") return (r.unresolved_rows ?? 0) > 0 ? "map_only_backfill" : "no_action";
  if (r.name === "expected_packages") {
    if ((r.unresolved_rows ?? 0) > 30) return "manual_review";
    return (r.unresolved_rows ?? 0) > 0 ? "map_only_backfill" : "no_action";
  }
  if (r.name === "amazon_settlements") return "sp_api_evidence";
  if (r.name === "amazon_fba_inventory" || r.name === "amazon_manage_fba_inventory") {
    return (r.unresolved_rows ?? 0) > 100 ? "product_promotion" : "map_only_backfill";
  }
  if (r.name.startsWith("amazon_")) return (r.unresolved_rows ?? 0) > 0 ? "map_only_backfill" : "no_action";
  if (r.category === "claim") return "manual_review";
  if (r.name === "slip_contents" || r.name === "shipment_box_items") return "manual_review";
  if (r.name === "return_items") return (r.unresolved_rows ?? 0) > 0 ? "map_only_backfill" : "no_action";
  if (r.category === "view-read-model") return "resolver_read_model";
  return (r.unresolved_rows ?? 0) > 0 ? "manual_review" : "no_action";
}

async function discoverLinkageEntities(client: pg.Client): Promise<string[]> {
  const r = await client.query(`
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema='public'
      AND t.table_type IN ('BASE TABLE','VIEW')
      AND c.column_name IN (
        'product_id','resolved_product_id','sku','fnsku','asin','upc','upc_code',
        'item_name','product_name','product_identifier'
      )
    ORDER BY 1
  `);
  return r.rows.map((x: { table_name: string }) => x.table_name);
}

function overallLinkagePercent(rows: CoverageRow[]): number {
  const scored = rows.filter(
    (r) =>
      ENTITY_SPECS.some((s) => s.name === r.name) &&
      r.category !== "aggregate" &&
      r.name !== "products" &&
      r.name !== "v_inventory_status" &&
      r.name !== "product_identifier_map" &&
      r.total_rows > 0 &&
      r.linkage_percent != null,
  );
  const totalWeight = scored.reduce((s, r) => s + r.total_rows, 0);
  if (!totalWeight) return 0;
  const weighted = scored.reduce((s, r) => s + (r.linkage_percent ?? 0) * r.total_rows, 0);
  return Math.round((weighted / totalWeight) * 10) / 10;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) throw new Error("Staging guard failed");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (!url || refFromSupabaseUrl(url) !== STAGING_REF) throw new Error("Supabase guard failed");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const discovered = await discoverLinkageEntities(client);
  const specNames = new Set(ENTITY_SPECS.map((s) => s.name));
  const extraNames = discovered.filter((n) => !specNames.has(n) && !n.startsWith("pg_"));

  const allSpecs = [
    ...ENTITY_SPECS,
    ...extraNames.map(
      (name): EntitySpec => ({
        name,
        kind: name.startsWith("v_") ? "view" : "table",
        category: "discovered",
        persist_mode: "read_model_only",
        active_filter_sql: "TRUE",
        neda_dependency: "none",
        owner: "discovered",
        notes: "Auto-included from information_schema linkage columns",
      }),
    ),
  ];

  const rows: CoverageRow[] = [];
  for (const spec of allSpecs) {
    rows.push(await auditEntity(client, spec));
  }
  await client.end();

  const overallPct = overallLinkagePercent(rows);
  const nedaItemTables = ["expected_packages", "return_items", "slip_contents"];
  const nedaItemRows = rows.filter((r) => nedaItemTables.includes(r.name));
  const nedaItemTotal = nedaItemRows.reduce((s, r) => s + r.total_rows, 0);
  const nedaItemResolved = nedaItemRows.reduce(
    (s, r) => s + (r.read_layer_resolved ?? r.persisted_resolved_product_id ?? 0),
    0,
  );
  const nedaCriticalItemLinkagePercent =
    nedaItemTotal > 0 ? Math.round((nedaItemResolved / nedaItemTotal) * 1000) / 10 : null;
  const topMissing = rows
    .filter(
      (r) =>
        ENTITY_SPECS.some((s) => s.name === r.name) &&
        r.category !== "aggregate" &&
        r.name !== "products" &&
        r.name !== "v_inventory_status" &&
        r.name !== "product_identifier_map",
    )
    .map((r) => ({
      name: r.name,
      unresolved: r.unresolved_rows ?? 0,
      total: r.total_rows,
      pct: r.linkage_percent,
      next_action: r.next_action,
      score: (r.unresolved_rows ?? 0) * (r.neda_ui_dependency === "critical" ? 10 : 1),
    }))
    .filter((r) => r.unresolved > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const nedaBlocking = rows.filter(
    (r) => r.neda_ui_dependency === "critical" && (r.unresolved_rows ?? 0) > 0 && r.name !== "v_inventory_status",
  );

  const matrix = rows.map((r) => ({
    name: r.name,
    kind: r.kind,
    category: r.category,
    total_rows: r.total_rows,
    persisted_product_id: r.persisted_product_id,
    persisted_resolved_product_id: r.persisted_resolved_product_id,
    read_layer_resolved: r.read_layer_resolved,
    identifier_only_rows: r.identifier_only_rows,
    item_name_only_rows: r.item_name_only_rows,
    unresolved_rows: r.unresolved_rows,
    ambiguous_rows: r.ambiguous_rows,
    persist_mode: r.persist_mode,
    linkage_percent: r.linkage_percent,
    neda_ui_dependency: r.neda_ui_dependency,
    next_action: r.next_action,
    query_errors: r.query_errors,
    notes: r.notes,
  }));

  fs.writeFileSync(path.join(outDir, "table-coverage-matrix.json"), JSON.stringify(matrix, null, 2));

  const reportMd = [
    "# Product linkage coverage report",
    "",
    `**Run id:** \`${runId}\``,
    `**Branch:** \`${branch}\``,
    `**Staging:** \`${STAGING_REF}\``,
    `**Overall weighted linkage (curated report/item tables):** **${overallPct}%**`,
    `**Neda critical item tables (EP + return_items + slip_contents):** **${nedaCriticalItemLinkagePercent}%** read-layer/persist resolved`,
    "",
    "| Table/View | Total | Persist product_id | Persist resolved | Read-layer resolved | Id-only | Name-only | Unresolved | Ambiguous | Link % | Persist mode | Neda | Next action |",
    "|------------|------:|-------------------:|-----------------:|--------------------:|--------:|----------:|-----------:|----------:|-------:|--------------|------|-------------|",
    ...rows
      .sort((a, b) => (b.unresolved_rows ?? 0) - (a.unresolved_rows ?? 0))
      .map(
        (r) =>
          `| ${r.name} | ${r.total_rows} | ${r.persisted_product_id ?? "—"} | ${r.persisted_resolved_product_id ?? "—"} | ${r.read_layer_resolved ?? "—"} | ${r.identifier_only_rows ?? "—"} | ${r.item_name_only_rows ?? "—"} | ${r.unresolved_rows ?? "—"} | ${r.ambiguous_rows ?? "—"} | ${r.linkage_percent ?? "—"} | ${r.persist_mode} | ${r.neda_ui_dependency} | ${r.next_action} |`,
      ),
    "",
    "## Answer: are products fully linked?",
    "",
    overallPct >= 95
      ? "**Mostly yes** on high-volume report tables; **no** on operational item cohorts (expected_packages, slip_contents, return_items gaps)."
      : "**No** — material gaps remain on item-level and import tables despite strong catalog spine coverage.",
    "",
    `Discovered linkage relations audited: **${rows.length}** (${ENTITY_SPECS.length} curated + ${extraNames.length} auto-discovered).`,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "product-linkage-coverage-report.md"), `${reportMd}\n`);

  fs.writeFileSync(
    path.join(outDir, "neda-operator-dependency-map.md"),
    [
      "# Neda / operator UI dependency map",
      "",
      "## Critical surfaces",
      "",
      "| Surface | Table/View | Unresolved | Link % | Requirement |",
      "|---------|------------|----------:|-------:|-------------|",
      ...rows
        .filter((r) => r.neda_ui_dependency === "critical")
        .map(
          (r) =>
            `| ${r.owner} | \`${r.name}\` | ${r.unresolved_rows ?? 0} | ${r.linkage_percent ?? "—"}% | ProductLinkageDisplayContract + resolver |`,
        ),
      "",
      "## Blocking gaps (critical + unresolved)",
      "",
      ...(nedaBlocking.length
        ? nedaBlocking.map(
            (r) =>
              `- **\`${r.name}\`**: ${r.unresolved_rows} unresolved — ${r.next_action}`,
          )
        : ["- None on critical tables with zero unresolved."]),
      "",
      "## Secondary / none",
      "",
      "- packages, pallets, shipment_boxes: indirect via return_items",
      "- v_inventory_status: package aggregate only (by design)",
      "- claim_evidence_lineage_events: audit graph, not product display",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "unresolved-priority-list.md"),
    [
      "# Unresolved priority list",
      "",
      "| Rank | Table | Unresolved | Total | Link % | Neda | Next action |",
      "|-----:|-------|----------:|------:|-------:|------|-------------|",
      ...topMissing.map(
        (r, i) =>
          `| ${i + 1} | ${r.name} | ${r.unresolved} | ${r.total} | ${r.pct ?? "—"}% | ${rows.find((x) => x.name === r.name)?.neda_ui_dependency ?? "—"} | ${r.next_action} |`,
      ),
    ].join("\n") + "\n",
  );

  const ep = rows.find((r) => r.name === "expected_packages");
  const ri = rows.find((r) => r.name === "return_items");
  const sc = rows.find((r) => r.name === "slip_contents");
  const afi = rows.find((r) => r.name === "amazon_amazon_fulfilled_inventory");

  fs.writeFileSync(
    path.join(outDir, "next-linkage-waves.md"),
    [
      "# Next linkage migration waves",
      "",
      "## Wave 0 — expected_packages source hygiene (blocks Neda expected)",
      "",
      `- ${ep?.unresolved_rows ?? "?"} unresolved / ${ep?.total_rows ?? "?"} total (${ep?.linkage_percent ?? "?"}% linked)`,
      "- Actions: dirty source fix (38 rows), then map-only, manual clean 5",
      "- Prompt: **PC03-EXEC — EXPECTED-PACKAGES-DIRTY-SOURCE-FIX-EXECUTE**",
      "",
      "## Wave 1 — return_items + slip_contents persist backfill",
      "",
      `- return_items: ${ri?.unresolved_rows ?? "?"} unresolved; ${ri?.linkage_percent ?? "?"}%`,
      `- slip_contents: ${sc?.unresolved_rows ?? "?"} unresolved; ${sc?.linkage_percent ?? "?"}%`,
      "- Actions: resolver-on-save + governed map-only backfill",
      "",
      "## Wave 2 — Amazon report spine (volume)",
      "",
      `- AFI: ${afi?.unresolved_rows ?? "?"} unresolved / ${afi?.total_rows ?? "?"} (${afi?.linkage_percent ?? "?"}%)`,
      "- Actions: map-only refresh; FBA/manage-FBA product_promotion where trusted name",
      "",
      "## Wave 3 — Claims upstream",
      "",
      "- claim_candidate_drafts / claim_candidates: fix source linkage before claim materialization",
      "",
      "## Wave 4 — Views (read-model)",
      "",
      "- v_inventory_item_status / v_scanned_items_counted: inherit fixes from base tables; resolver_read_model only",
      "",
      "## No migration needed",
      "",
      "- products, packages, pallets, shipment_containers, v_inventory_status (aggregate)",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      "- Read-only audit; no DB writes.",
      "- expected_packages **read-layer-only** — no bulk resolved_product_id persist on source.",
      "- 38 dirty EP identifiers block map waves.",
      "- Slip/return have no exact catalog proof for bulk backfill (PC03A).",
      "- SP-API evidence gated (`APPROVED_SP_API_EVIDENCE_DRY_RUN=false`).",
      ...rows.filter((r) => r.query_errors.length).map((r) => `- Query error **${r.name}**: ${r.query_errors.join("; ")}`),
    ].join("\n") + "\n",
  );

  const safestPrompt =
    (ep?.unresolved_rows ?? 0) > 0
      ? "PC03-EXEC — EXPECTED-PACKAGES-DIRTY-SOURCE-FIX-EXECUTE"
      : (ri?.unresolved_rows ?? 0) > 0
        ? "PC03A-EXEC — RETURN-ITEMS-MAP-ONLY-BACKFILL-EXECUTE"
        : "PC03A — EXPECTED-RETURN-SLIP-MAP-ONLY-EXECUTE-PLAN (re-run)";

  const manifest = {
    prompt: "PRODUCT LINKAGE TABLE COVERAGE AUDIT — ALL OPERATIONAL TABLES",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: "PASS",
    output_dir: `${OUT_BASE}/${runId}`,
    relations_audited: rows.length,
    curated_specs: ENTITY_SPECS.length,
    auto_discovered: extraNames.length,
    overall_weighted_linkage_percent: overallPct,
    neda_critical_item_linkage_percent: nedaCriticalItemLinkagePercent,
    top_5_unresolved_tables: topMissing.map((r) => r.name),
    neda_blocking_gaps: nedaBlocking.map((r) => ({
      name: r.name,
      unresolved: r.unresolved_rows,
      next_action: r.next_action,
    })),
    safest_next_prompt: safestPrompt,
    forbidden: { db_writes: false, product_create: false, amazon_api: false },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
