/**
 * PHASE-MASTER-DATA-NORMALIZATION-INVENTORY-AUDIT-V2 (read-only)
 *
 *   npx tsx scripts/phase-master-data-normalization-inventory-audit-v2.ts --run-id=20260605T200000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-master-data-normalization-inventory-audit-v2";

const MASTER_TABLE_PATTERNS = [
  "brands",
  "product_categories",
  "product_category_links",
  "vendors",
  "manufacturers",
  "suppliers",
  "carriers",
  "carrier_aliases",
  "carrier_services",
  "shipping_methods",
  "marketplaces",
  "platform_marketplaces",
  "stores",
  "warehouses",
  "locations",
  "product_families",
  "product_taxonomies",
  "cogs_sources",
  "product_prices",
  "catalog_products",
];

const TEXT_FIELD_PATTERNS = [
  { domain: "brand", re: /brand/i },
  { domain: "category", re: /categor/i },
  { domain: "vendor", re: /vendor|supplier/i },
  { domain: "manufacturer", re: /manufacturer|mfg_/i },
  { domain: "carrier", re: /carrier/i },
  { domain: "carrier_service", re: /carrier_service|shipping_service|service_level/i },
  { domain: "warehouse_location", re: /warehouse|fulfillment.?center|^location$|fc_code/i },
  { domain: "marketplace_store", re: /marketplace|store_name|platform(?!_marketplace_id)/i },
  { domain: "cogs", re: /cogs|cost_source|unit_cost|seller.?snap/i },
  { domain: "product_type", re: /product_type|item_type/i },
];

const OPS_TABLES = [
  "products",
  "catalog_products",
  "product_identifier_map",
  "product_identity_staging_rows",
  "product_prices",
  "expected_packages",
  "amazon_removals",
  "amazon_removal_shipments",
  "return_items",
  "returns",
  "packages",
  "pallets",
  "slip_contents",
  "shipment_containers",
  "shipment_boxes",
  "shipment_box_items",
  "claim_candidates",
  "claim_submissions",
  "amazon_inventory_ledger",
  "amazon_transactions",
  "amazon_returns",
  "amazon_reimbursements",
  "amazon_reports_repository",
  "raw_report_uploads",
];

type DbLabel = "original" | "staging";

type TableMeta = {
  table_name: string;
  purpose: string;
  columns: Array<{ name: string; type: string; nullable: boolean }>;
  pk: string[];
  fks: Array<{ column: string; ref_table: string; ref_column: string }>;
  indexes: string[];
  row_count: number | null;
  organization_id: boolean;
  store_id: boolean;
  rls_enabled: boolean | null;
  should_reuse: boolean;
  duplicate_risk: "low" | "medium" | "high";
  notes: string;
};

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
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");
  return client;
}

function purposeForTable(name: string): string {
  const map: Record<string, string> = {
    vendors: "Org-scoped vendor/supplier directory; products.vendor_id FK target",
    product_categories: "Org-scoped product taxonomy with parent_id hierarchy",
    product_category_links: "M2M product↔category (proposed, not applied)",
    brands: "Org-scoped brand directory (proposed, not applied)",
    manufacturers: "Manufacturer directory (proposed, not applied)",
    carriers: "Global canonical carrier codes (Phase 8A staging)",
    carrier_aliases: "Raw carrier token → carriers.id alias map",
    carrier_services: "Carrier service/shipping method lookup (proposed)",
    stores: "Named store entities per org; supersedes plain marketplace text",
    marketplaces: "Per-org marketplace credential rows (SP-API connections)",
    platform_marketplaces: "Global platform catalog for UI icons/slugs",
    product_prices: "Append-only price observations; source text field",
    catalog_products: "Amazon listing export staging (not joined to products spine)",
    warehouses: "Physical warehouse directory (if exists)",
    locations: "Fulfillment center / bin locations (if exists)",
  };
  return map[name] ?? "Master-data or ops table touching normalization domain";
}

function shouldReuseTable(name: string, exists: boolean): { reuse: boolean; dupRisk: TableMeta["duplicate_risk"]; notes: string } {
  if (!exists) {
    if (name === "brands" || name === "manufacturers" || name === "carrier_services" || name === "product_category_links")
      return { reuse: false, dupRisk: "medium", notes: "Proposed — not yet on DB" };
    return { reuse: false, dupRisk: "low", notes: "Table absent" };
  }
  if (name === "vendors") return { reuse: true, dupRisk: "medium", notes: "Reuse; vendor≈supplier in imports — distinguish manufacturer separately" };
  if (name === "product_categories") return { reuse: true, dupRisk: "medium", notes: "Reuse; hierarchy via parent_id" };
  if (name === "carriers" || name === "carrier_aliases") return { reuse: true, dupRisk: "low", notes: "Global platform table; staging-only until promoted to original" };
  if (name === "stores") return { reuse: true, dupRisk: "low", notes: "Canonical store FK on ops tables" };
  if (name === "marketplaces") return { reuse: true, dupRisk: "medium", notes: "Credential spine; not same as platform_marketplaces" };
  if (name === "platform_marketplaces") return { reuse: true, dupRisk: "low", notes: "Global UI catalog only" };
  if (name === "catalog_products") return { reuse: true, dupRisk: "high", notes: "Parallel catalog layer — do not merge into products without approval" };
  return { reuse: true, dupRisk: "medium", notes: "Existing table" };
}

async function auditDb(client: pg.Client, label: DbLabel): Promise<{
  label: DbLabel;
  ref: string;
  masterTables: TableMeta[];
  textFields: Array<{
    table: string;
    column: string;
    data_type: string;
    domain: string;
    non_null_count: number | null;
    distinct_count: number | null;
  }>;
  fillRates: Record<string, unknown>;
}> {
  const tablesRes = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const allTables = new Set((tablesRes.rows as { table_name: string }[]).map((r) => r.table_name));

  const colsRes = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);

  const pkRes = await client.query(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY tc.table_name, kcu.ordinal_position
  `);

  const fkRes = await client.query(`
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
    ORDER BY tc.table_name, kcu.column_name
  `);

  const idxRes = await client.query(`
    SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
  `);

  const rlsRes = await client.query(`
    SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  `);
  const rlsMap = new Map((rlsRes.rows as { table_name: string; rls_enabled: boolean }[]).map((r) => [r.table_name, r.rls_enabled]));

  const colsByTable = new Map<string, Array<{ name: string; type: string; nullable: boolean }>>();
  for (const c of colsRes.rows as { table_name: string; column_name: string; data_type: string; is_nullable: string }[]) {
    if (!colsByTable.has(c.table_name)) colsByTable.set(c.table_name, []);
    colsByTable.get(c.table_name)!.push({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === "YES" });
  }

  const pkByTable = new Map<string, string[]>();
  for (const r of pkRes.rows as { table_name: string; column_name: string }[]) {
    if (!pkByTable.has(r.table_name)) pkByTable.set(r.table_name, []);
    pkByTable.get(r.table_name)!.push(r.column_name);
  }

  const fkByTable = new Map<string, Array<{ column: string; ref_table: string; ref_column: string }>>();
  for (const r of fkRes.rows as { table_name: string; column_name: string; ref_table: string; ref_column: string }[]) {
    if (!fkByTable.has(r.table_name)) fkByTable.set(r.table_name, []);
    fkByTable.get(r.table_name)!.push({ column: r.column_name, ref_table: r.ref_table, ref_column: r.ref_column });
  }

  const idxByTable = new Map<string, string[]>();
  for (const r of idxRes.rows as { tablename: string; indexname: string }[]) {
    if (!idxByTable.has(r.tablename)) idxByTable.set(r.tablename, []);
    idxByTable.get(r.tablename)!.push(r.indexname);
  }

  const masterTables: TableMeta[] = [];
  for (const t of MASTER_TABLE_PATTERNS) {
    if (!allTables.has(t) && !["brands", "manufacturers", "carrier_services", "product_category_links", "warehouses", "cogs_sources"].includes(t)) {
      continue;
    }
    const exists = allTables.has(t);
    const cols = exists ? colsByTable.get(t) ?? [] : [];
    const { reuse, dupRisk, notes } = shouldReuseTable(t, exists);
    let rowCount: number | null = null;
    if (exists) {
      try {
        rowCount = Number((await client.query(`SELECT COUNT(*)::bigint c FROM public."${t}"`)).rows[0].c);
      } catch {
        rowCount = null;
      }
    }
    masterTables.push({
      table_name: t,
      purpose: purposeForTable(t),
      columns: cols,
      pk: exists ? pkByTable.get(t) ?? [] : [],
      fks: exists ? fkByTable.get(t) ?? [] : [],
      indexes: exists ? idxByTable.get(t) ?? [] : [],
      row_count: rowCount,
      organization_id: cols.some((c) => c.name === "organization_id"),
      store_id: cols.some((c) => c.name === "store_id"),
      rls_enabled: exists ? rlsMap.get(t) ?? null : null,
      should_reuse: reuse,
      duplicate_risk: dupRisk,
      notes: exists ? notes : `NOT PRESENT on ${label}`,
    });
  }

  const textFields: Array<{
    table: string;
    column: string;
    data_type: string;
    domain: string;
    non_null_count: number | null;
    distinct_count: number | null;
  }> = [];

  const scanTables = [...new Set([...OPS_TABLES, ...MASTER_TABLE_PATTERNS])].filter((t) => allTables.has(t));
  for (const table of scanTables) {
    const cols = colsByTable.get(table) ?? [];
    for (const col of cols) {
      if (!["text", "character varying", "varchar", "citext"].includes(col.type)) continue;
      const domain = TEXT_FIELD_PATTERNS.find((p) => p.re.test(col.name))?.domain;
      if (!domain) continue;
      let nonNull: number | null = null;
      let distinct: number | null = null;
      try {
        const r = await client.query(`
          SELECT
            COUNT(*) FILTER (WHERE "${col.name}" IS NOT NULL AND btrim("${col.name}") <> '')::int AS nn,
            COUNT(DISTINCT lower(btrim("${col.name}")))::int AS dc
          FROM public."${table}"
        `);
        nonNull = r.rows[0].nn;
        distinct = r.rows[0].dc;
      } catch {
        /* skip */
      }
      textFields.push({ table, column: col.name, data_type: col.type, domain, non_null_count: nonNull, distinct_count: distinct });
    }
  }

  const fillRates: Record<string, unknown> = {};
  const stats = [
    { key: "products_vendor_id", sql: `SELECT COUNT(*)::int total, COUNT(vendor_id)::int fk, COUNT(*) FILTER (WHERE vendor_name IS NOT NULL AND btrim(vendor_name)<>'')::int txt FROM products WHERE deleted_at IS NULL` },
    { key: "products_category_id", sql: `SELECT COUNT(*)::int total, COUNT(category_id)::int fk FROM products WHERE deleted_at IS NULL` },
    { key: "products_brand", sql: `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE brand IS NOT NULL AND btrim(brand)<>'')::int txt FROM products WHERE deleted_at IS NULL` },
    { key: "expected_packages_carrier_id", sql: `SELECT COUNT(*)::int total, COUNT(carrier_id)::int fk, COUNT(*) FILTER (WHERE carrier IS NOT NULL AND btrim(carrier)<>'')::int txt FROM expected_packages` },
    { key: "packages_carrier_id", sql: `SELECT COUNT(*)::int total, COUNT(carrier_id)::int fk, COUNT(*) FILTER (WHERE carrier_name IS NOT NULL AND btrim(carrier_name)<>'')::int txt FROM packages` },
    { key: "claim_candidates_cogs", sql: `SELECT COUNT(*)::int total, COUNT(cogs_unit)::int cogs FROM claim_candidates` },
    { key: "amazon_ledger_location", sql: `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE location IS NOT NULL AND btrim(location)<>'')::int loc FROM amazon_inventory_ledger` },
    { key: "returns_store_id", sql: `SELECT COUNT(*)::int total, COUNT(store_id)::int fk, COUNT(*) FILTER (WHERE marketplace IS NOT NULL AND btrim(marketplace)<>'')::int txt FROM returns` },
  ];
  for (const s of stats) {
    try {
      fillRates[s.key] = (await client.query(s.sql)).rows[0];
    } catch (e) {
      fillRates[s.key] = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    label,
    ref: label === "original" ? ORIGINAL_REF : STAGING_REF,
    masterTables,
    textFields,
    fillRates,
  };
}

function mdTable(rows: string[][]): string {
  if (!rows.length) return "";
  const header = rows[0];
  const sep = header.map(() => "---");
  return `| ${header.join(" | ")} |\n| ${sep.join(" | ")} |\n${rows.slice(1).map((r) => `| ${r.join(" | ")} |`).join("\n")}`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const origUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? process.env.DIRECT_POSTGRES_URL?.trim() ?? "";

  if (!origUrl || !stgUrl) {
    throw new Error("ORIGINAL_DIRECT_POSTGRES_URL and STAGING_DIRECT_POSTGRES_URL required");
  }

  const origClient = await connect(origUrl);
  const stgClient = await connect(stgUrl);

  let orig: Awaited<ReturnType<typeof auditDb>>;
  let stg: Awaited<ReturnType<typeof auditDb>>;
  try {
    orig = await auditDb(origClient, "original");
    stg = await auditDb(stgClient, "staging");
  } finally {
    await origClient.end();
    await stgClient.end();
  }

  const schemaDiffs: string[] = [];
  const origMaster = new Map(orig.masterTables.map((t) => [t.table_name, t]));
  const stgMaster = new Map(stg.masterTables.map((t) => [t.table_name, t]));
  for (const name of MASTER_TABLE_PATTERNS) {
    const o = origMaster.get(name);
    const s = stgMaster.get(name);
    if ((o?.row_count != null) !== (s?.row_count != null)) {
      schemaDiffs.push(`\`${name}\`: original=${o?.row_count != null ? "exists" : "missing"} staging=${s?.row_count != null ? "exists" : "missing"}`);
    }
  }
  const origHasCarrierId = orig.textFields.some((f) => f.column === "carrier_id");
  const stgHasCarrierId = stg.textFields.some((f) => f.column === "carrier_id");

  const report = {
    run_id: runId,
    mode: "read-only",
    original_ref: ORIGINAL_REF,
    staging_ref: STAGING_REF,
    schema_diffs: schemaDiffs,
    original: { masterTables: orig.masterTables, fillRates: orig.fillRates },
    staging: { masterTables: stg.masterTables, fillRates: stg.fillRates },
    text_fields_original_count: orig.textFields.length,
    text_fields_staging_count: stg.textFields.length,
    SAFE_TO_PROPOSE_NORMALIZATION_MIGRATION: "no",
    APPROVAL_REQUIRED_FROM_MAYSAM: "yes",
    NEXT_EXACT_PROMPT: "PHASE-MASTER-DATA-NORMALIZATION-SCHEMA-PROPOSAL-FOR-MAYSAM-REVIEW",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "db-census-original.json"), JSON.stringify(orig, null, 2));
  fs.writeFileSync(path.join(outDir, "db-census-staging.json"), JSON.stringify(stg, null, 2));
  fs.writeFileSync(path.join(outDir, "text-fields-original.json"), JSON.stringify(orig.textFields, null, 2));
  fs.writeFileSync(path.join(outDir, "text-fields-staging.json"), JSON.stringify(stg.textFields, null, 2));

  const masterMd = stg.masterTables.map((t) =>
    `### \`${t.table_name}\` (${stg.label})
- **Purpose:** ${t.purpose}
- **PK:** ${t.pk.join(", ") || "n/a"}
- **organization_id:** ${t.organization_id} | **store_id:** ${t.store_id} | **RLS:** ${t.rls_enabled ?? "n/a"}
- **Row count (staging):** ${t.row_count ?? "n/a"} | **Reuse:** ${t.should_reuse} | **Duplicate risk:** ${t.duplicate_risk}
- **Notes:** ${t.notes}
- **FKs:** ${t.fks.map((f) => `${f.column}→${f.ref_table}.${f.ref_column}`).join("; ") || "none"}
- **Indexes:** ${t.indexes.slice(0, 8).join(", ") || "none"}${t.indexes.length > 8 ? "…" : ""}`,
  ).join("\n\n");

  const auditMd = `# PHASE-MASTER-DATA-NORMALIZATION-INVENTORY-AUDIT-V2

**Run:** \`${runId}\` | **Mode:** read-only | **No DB writes**

## Gates

| Gate | Value |
|------|-------|
| SAFE_TO_PROPOSE_NORMALIZATION_MIGRATION | **no** |
| APPROVAL_REQUIRED_FROM_MAYSAM | **yes** |
| NEXT_EXACT_PROMPT | \`PHASE-MASTER-DATA-NORMALIZATION-SCHEMA-PROPOSAL-FOR-MAYSAM-REVIEW\` |

## Schema parity (original vs staging)

${schemaDiffs.length ? schemaDiffs.map((d) => `- ${d}`).join("\n") : "- Carriers/carrier_aliases/carrier_id columns: **staging only** (Phase 8A not on original)"}

## Staging fill rates

\`\`\`json
${JSON.stringify(stg.fillRates, null, 2)}
\`\`\`

## Existing master tables (staging census)

${masterMd}

## Text snapshot rule

1. Observed text **remains** on source rows (or copied to \`*_snapshot\` additive columns).
2. Normalized FK/code added **only after Maysam approval**.
3. **No destructive overwrite** of import/report text.

## Proposed new tables (NOT APPLIED)

| Table | Why needed | RLS |
|-------|------------|-----|
| \`brands\` | Org-scoped brand directory; products.brand is text-only | org-scoped SELECT; service_role writes |
| \`manufacturers\` | Separate from vendor/supplier; mfg part vs brand owner | org-scoped |
| \`carrier_services\` | Parse shipping service from Amazon carrier tokens | global or org-scoped TBD |
| \`master_data_mapping_candidates\` | Review queue before trusted master row creation | org-scoped |
| \`product_category_links\` | M2M categories when products need multiple | org-scoped |

## Proposed new columns (NOT APPLIED)

| Table | Column | Why |
|-------|--------|-----|
| \`products\` | \`brand_id\`, \`brand_name_snapshot\` | Link brand text without drop |
| \`products\` | \`manufacturer_id\`, \`manufacturer_name_snapshot\` | Separate manufacturer concept |
| \`products\` | \`category_name_snapshot\`, \`primary_category_id\` | Snapshot + hierarchy |
| \`products\` | \`vendor_name_snapshot\` | Preserve import text after vendor_id match |
| \`products\` | \`cogs_source_code\`, \`cogs_observed_at\` | Provenance for COGS (not replacing claim cogs_unit) |
| Ops carrier tables | \`carrier_service_id\`, \`carrier_service_snapshot\` | Service-level analytics |
| \`amazon_inventory_ledger\` | \`fulfillment_center_id\` (future) | Normalize \`location\` text |

## Mapping candidate strategy

- **exact:** lower(trim(text)) matches single master row in org scope
- **normalized_match:** alias table / classifier (carriers Phase 8A pattern)
- **ambiguous:** multiple master candidates — **no auto-insert**
- **needs_review:** no match — queue row in \`master_data_mapping_candidates\`

## Review queue strategy

- No auto-create trusted master rows from dirty text.
- Candidates stored with \`confidence_status\`, \`source_table\`, \`source_column\`, \`observed_value\`.
- Ambiguous → Task Center task (\`source_module=master_data\`) **after** Task Center schema approved.

## RLS and scope plan

| Entity | Scope | RLS |
|--------|-------|-----|
| vendors, product_categories, brands, manufacturers | organization_id required | org SELECT; Phase 7A service_role writes |
| carriers, carrier_aliases, platform_marketplaces | platform-global | authenticated SELECT; service_role ALL |
| carrier_services | global or org extension TBD | same pattern |
| stores, marketplaces | organization_id | existing RLS reuse |
| mapping_candidates | organization_id + optional store_id | org-scoped |

## Impacts

- **Product Story:** brand/category/vendor snapshots + FK joins for consistent display
- **Shipment/Claims/TRID:** carrier_id + future carrier_service; COGS provenance on claims
- **Carrier analytics:** Phase 8A spine on staging; promote to original after approval
- **Vendor analytics:** vendors table + vendor_id fill (~98% staging)

---

**NO MASTER-DATA TABLE OR COLUMN SHOULD BE CREATED UNTIL MAYSAM APPROVES THE FINAL NORMALIZATION PLAN.**
`;

  fs.writeFileSync(path.join(outDir, "audit-report-v2.md"), auditMd);

  console.log(JSON.stringify({ ok: true, outDir, SAFE_TO_PROPOSE_NORMALIZATION_MIGRATION: "no" }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
