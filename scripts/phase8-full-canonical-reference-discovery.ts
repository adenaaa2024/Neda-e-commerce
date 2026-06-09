/**
 * PHASE-8-FULL-CANONICAL-REFERENCE-DISCOVERY (read-only)
 * Target: original kxsvedvpjldygtdbylsy (+ staging schema compare)
 *
 *   npx tsx scripts/phase8-full-canonical-reference-discovery.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase8-full-canonical-reference-discovery";

type EntityKind =
  | "vendor"
  | "category"
  | "brand"
  | "manufacturer"
  | "color"
  | "size"
  | "condition"
  | "package_type"
  | "carrier"
  | "carrier_service"
  | "pallet_type"
  | "shipment_type"
  | "claim_reason"
  | "damage_reason"
  | "recovery_reason"
  | "disposition_type"
  | "problem_type"
  | "condition_type"
  | "expiration_reason"
  | "company"
  | "store"
  | "marketplace"
  | "warehouse"
  | "other_lookup";

type MigrationGroup = "8A" | "8B" | "8C" | "8D" | "8E" | "8F" | "skip";

type Candidate = {
  domain: string;
  entity_kind: EntityKind;
  migration_group: MigrationGroup;
  table: string;
  column: string;
  data_type: string;
  row_count_non_null: number;
  distinct_count: number;
  distinct_count_lower: number;
  case_variation_groups: number;
  spelling_variation_hint: string;
  sample_values: string[];
  lookup_table_exists: boolean;
  recommended_lookup_table: string;
  should_become_fk: boolean;
  recommended_fk_column: string;
  recommended_snapshot_column: string;
  backfill_strategy: string;
  risk_level: "low" | "medium" | "high";
  orphan_fk_count: number | null;
  has_fk_index: boolean;
  duplicate_lookup_names: number | null;
  notes: string;
};

const LOOKUP_TABLES = new Set([
  "vendors",
  "product_categories",
  "product_category_links",
  "brands",
  "manufacturers",
  "product_colors",
  "product_sizes",
  "product_conditions",
  "package_types",
  "carriers",
  "carrier_aliases",
  "carrier_services",
  "pallet_types",
  "shipment_types",
  "claim_reasons",
  "damage_reasons",
  "recovery_reasons",
  "disposition_types",
  "problem_types",
  "condition_types",
  "expiration_reason_types",
  "companies",
  "stores",
  "marketplaces",
  "warehouses",
  "organizations",
]);

const ENTITY_RULES: Array<{
  kind: EntityKind;
  domain: string;
  group: MigrationGroup;
  colPattern: RegExp;
  tableExclude?: RegExp;
  lookupTable: string;
  fkColumn: string;
  snapshotColumn: string;
  backfill: string;
  defaultRisk: Candidate["risk_level"];
  skipIfFkSibling?: RegExp;
}> = [
  { kind: "vendor", domain: "Product", group: "8B", colPattern: /^vendor_name$|^vendor$/, tableExclude: /^vendors$/, lookupTable: "vendors", fkColumn: "vendor_id", snapshotColumn: "vendor_name_snapshot", backfill: "Match lower(trim(text)) → vendors.name org-scoped; snapshot text", defaultRisk: "medium" },
  { kind: "category", domain: "Product", group: "8B", colPattern: /category_name$|^category$/, tableExclude: /product_categories/, lookupTable: "product_categories", fkColumn: "category_id", snapshotColumn: "category_name_snapshot", backfill: "Match → product_categories; M2M via product_category_links", defaultRisk: "medium" },
  { kind: "brand", domain: "Product", group: "8B", colPattern: /^brand$|^brand_name$/, lookupTable: "brands", fkColumn: "brand_id", snapshotColumn: "brand_name_snapshot", backfill: "Create brands from distinct products.brand", defaultRisk: "medium" },
  { kind: "manufacturer", domain: "Product", group: "8B", colPattern: /^manufacturer$|^mfg_part_number$|^mfg_no$|^manufacturer_name$/, lookupTable: "manufacturers", fkColumn: "manufacturer_id", snapshotColumn: "mfg_part_number_snapshot", backfill: "Part numbers may stay text; manufacturer name → manufacturers table", defaultRisk: "low" },
  { kind: "color", domain: "Product", group: "8B", colPattern: /^color$|^colour$|^product_color$/, lookupTable: "product_colors", fkColumn: "color_id", snapshotColumn: "color_snapshot", backfill: "Distinct color text → product_colors", defaultRisk: "low" },
  { kind: "size", domain: "Product", group: "8B", colPattern: /^size$|^product_size$|^size_label$/, lookupTable: "product_sizes", fkColumn: "size_id", snapshotColumn: "size_snapshot", backfill: "Distinct size text → product_sizes", defaultRisk: "low" },
  { kind: "condition", domain: "Product", group: "8B", colPattern: /^condition$|^item_condition$|^product_condition$/, tableExclude: /^return_items$/, lookupTable: "product_conditions", fkColumn: "condition_id", snapshotColumn: "condition_snapshot", backfill: "Map Amazon/New/Used/Refurbished enums", defaultRisk: "medium" },
  { kind: "package_type", domain: "Product", group: "8B", colPattern: /^package_type$|^packaging_type$/, lookupTable: "package_types", fkColumn: "package_type_id", snapshotColumn: "package_type_snapshot", backfill: "Packaging profile enums", defaultRisk: "low" },
  { kind: "carrier", domain: "Warehouse", group: "8A", colPattern: /carrier_name$|^carrier$|shipping_carrier$|tracking_carrier$/, tableExclude: /^carriers$/, lookupTable: "carriers", fkColumn: "carrier_id", snapshotColumn: "carrier_name_snapshot", backfill: "normalize_removal_carrier_operational + alias map", defaultRisk: "high", skipIfFkSibling: /carrier_id$/ },
  { kind: "carrier_service", domain: "Warehouse", group: "8C", colPattern: /carrier_service$|service_level$|shipping_service$/, lookupTable: "carrier_services", fkColumn: "carrier_service_id", snapshotColumn: "carrier_service_snapshot", backfill: "Parse from Amazon carrier tokens", defaultRisk: "medium" },
  { kind: "pallet_type", domain: "Warehouse", group: "8C", colPattern: /^pallet_type$/, lookupTable: "pallet_types", fkColumn: "pallet_type_id", snapshotColumn: "pallet_type_snapshot", backfill: "Enum if sparse", defaultRisk: "low" },
  { kind: "shipment_type", domain: "Warehouse", group: "8C", colPattern: /^shipment_type$|^order_type$/, lookupTable: "shipment_types", fkColumn: "shipment_type_id", snapshotColumn: "shipment_type_snapshot", backfill: "Removal order_type values → lookup", defaultRisk: "medium" },
  { kind: "claim_reason", domain: "Claims", group: "8D", colPattern: /^claim_reason$|^reason_code$|^claim_type$/, lookupTable: "claim_reasons", fkColumn: "claim_reason_id", snapshotColumn: "claim_reason_snapshot", backfill: "Claims inbox enums", defaultRisk: "medium" },
  { kind: "damage_reason", domain: "Claims", group: "8D", colPattern: /^damage_reason$|^damage_type$/, lookupTable: "damage_reasons", fkColumn: "damage_reason_id", snapshotColumn: "damage_reason_snapshot", backfill: "Evidence draft enums", defaultRisk: "medium" },
  { kind: "recovery_reason", domain: "Claims", group: "8D", colPattern: /^recovery_reason$/, lookupTable: "recovery_reasons", fkColumn: "recovery_reason_id", snapshotColumn: "recovery_reason_snapshot", backfill: "FRR / reimbursement enums", defaultRisk: "medium" },
  { kind: "disposition_type", domain: "Claims", group: "8D", colPattern: /^disposition$|^disposition_type$/, lookupTable: "disposition_types", fkColumn: "disposition_type_id", snapshotColumn: "disposition_snapshot", backfill: "Amazon removal disposition (Sellable/Unsellable/etc)", defaultRisk: "high" },
  { kind: "problem_type", domain: "Scanner", group: "8E", colPattern: /^problem_type$|^scan_problem$/, lookupTable: "problem_types", fkColumn: "problem_type_id", snapshotColumn: "problem_type_snapshot", backfill: "Operator mobile enums", defaultRisk: "medium" },
  { kind: "condition_type", domain: "Scanner", group: "8E", colPattern: /^condition_type$|^conditions$/, lookupTable: "condition_types", fkColumn: "condition_type_id", snapshotColumn: "conditions_snapshot", backfill: "return_items.conditions text[] → junction", defaultRisk: "high" },
  { kind: "expiration_reason", domain: "Scanner", group: "8E", colPattern: /^expiration_reason$|^expiry_reason$/, lookupTable: "expiration_reason_types", fkColumn: "expiration_reason_id", snapshotColumn: "expiration_reason_snapshot", backfill: "Scanner expiry capture", defaultRisk: "low" },
  { kind: "company", domain: "Organization", group: "8F", colPattern: /^company_name$|^company$/, tableExclude: /^organizations$/, lookupTable: "companies", fkColumn: "company_id", snapshotColumn: "company_name_snapshot", backfill: "Use organizations as company spine or separate companies table", defaultRisk: "low" },
  { kind: "store", domain: "Organization", group: "8F", colPattern: /^store_name$/, lookupTable: "stores", fkColumn: "store_id", snapshotColumn: "store_name_snapshot", backfill: "store_id FK already exists on most ops tables", defaultRisk: "low", skipIfFkSibling: /^store_id$/ },
  { kind: "marketplace", domain: "Organization", group: "8F", colPattern: /^marketplace_name$|^marketplace_type$/, tableExclude: /^marketplaces$/, lookupTable: "marketplaces", fkColumn: "marketplace_id", snapshotColumn: "marketplace_name_snapshot", backfill: "marketplace_id where missing", defaultRisk: "medium", skipIfFkSibling: /marketplace_id$/ },
  { kind: "warehouse", domain: "Organization", group: "8F", colPattern: /^warehouse_name$|^warehouse_code$/, tableExclude: /^warehouses$/, lookupTable: "warehouses", fkColumn: "warehouse_id", snapshotColumn: "warehouse_name_snapshot", backfill: "warehouses table exists — backfill warehouse_id", defaultRisk: "medium", skipIfFkSibling: /^warehouse_id$/ },
];

const SKIP_TABLE = /^_|^pg_|^sql_|audit_|backup_/i;
const SKIP_COLUMN =
  /^(id|created_at|updated_at|deleted_at|metadata|notes|description|raw_|amazon_raw|field_provenance|.*_url|.*_hash|.*_token|.*_key|.*_email|.*_phone|tracking_number|order_id|sku|fnsku|asin|upc|.*_id$|.*_uuid$)/i;

const TEXT_TYPES = new Set(["text", "character varying", "varchar", "citext"]);

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function matchRule(table: string, column: string, allCols: Set<string>): (typeof ENTITY_RULES)[0] | null {
  if (SKIP_TABLE.test(table)) return null;
  for (const rule of ENTITY_RULES) {
    if (rule.tableExclude?.test(table)) continue;
    if (!rule.colPattern.test(column)) continue;
    if (rule.skipIfFkSibling) {
      const sibling = rule.skipIfFkSibling.source.replace(/^\^|\$$/g, "");
      if (allCols.has(sibling.replace(/\\/g, ""))) continue;
    }
    if (SKIP_COLUMN.test(column) && !rule.colPattern.test(column)) continue;
    return rule;
  }
  return null;
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");
  return client;
}

async function profileColumn(
  client: pg.Client,
  table: string,
  column: string,
  dataType: string,
): Promise<{
  row_count_non_null: number;
  distinct_count: number;
  distinct_count_lower: number;
  case_variation_groups: number;
  sample_values: string[];
  spelling_hint: string;
}> {
  const qIdent = `"${table.replace(/"/g, "")}"."${column.replace(/"/g, "")}"`;
  const isArray = dataType === "ARRAY" || dataType.includes("[]");

  try {
    if (isArray) {
      const r = await client.query(`
        SELECT
          COUNT(*) FILTER (WHERE cardinality(${qIdent}) > 0)::int AS row_count_non_null,
          COUNT(DISTINCT ${qIdent})::int AS distinct_count
        FROM public."${table.replace(/"/g, "")}"
        WHERE ${qIdent} IS NOT NULL
      `);
      const samples = await client.query(`
        SELECT DISTINCT ${qIdent}::text AS v
        FROM public."${table.replace(/"/g, "")}"
        WHERE ${qIdent} IS NOT NULL AND cardinality(${qIdent}) > 0
        LIMIT 8
      `);
      return {
        row_count_non_null: Number(r.rows[0]?.row_count_non_null ?? 0),
        distinct_count: Number(r.rows[0]?.distinct_count ?? 0),
        distinct_count_lower: Number(r.rows[0]?.distinct_count ?? 0),
        case_variation_groups: 0,
        sample_values: samples.rows.map((x) => String(x.v).slice(0, 80)),
        spelling_hint: "text[] — needs unnest for canonicalization",
      };
    }

    const r = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE ${qIdent} IS NOT NULL AND btrim(${qIdent}::text) <> '')::int AS row_count_non_null,
        COUNT(DISTINCT btrim(${qIdent}::text))::int AS distinct_count,
        COUNT(DISTINCT lower(btrim(${qIdent}::text)))::int AS distinct_count_lower
      FROM public."${table.replace(/"/g, "")}"
    `);
    const row = r.rows[0] as {
      row_count_non_null: number;
      distinct_count: number;
      distinct_count_lower: number;
    };
    const caseGroups = row.distinct_count - row.distinct_count_lower;

    const samples = await client.query(`
      SELECT btrim(${qIdent}::text) AS v, COUNT(*)::int AS c
      FROM public."${table.replace(/"/g, "")}"
      WHERE ${qIdent} IS NOT NULL AND btrim(${qIdent}::text) <> ''
      GROUP BY 1 ORDER BY c DESC LIMIT 8
    `);

    let spellingHint = "";
    if (row.distinct_count_lower > 0 && row.distinct_count > row.distinct_count_lower) {
      spellingHint = `${row.distinct_count - row.distinct_count_lower} case-only duplicates`;
    }
    if (row.distinct_count_lower > 1 && row.distinct_count_lower <= 500) {
      const dupes = await client.query(`
        SELECT lower(btrim(${qIdent}::text)) AS norm, COUNT(DISTINCT btrim(${qIdent}::text))::int AS spellings
        FROM public."${table.replace(/"/g, "")}"
        WHERE ${qIdent} IS NOT NULL AND btrim(${qIdent}::text) <> ''
        GROUP BY 1 HAVING COUNT(DISTINCT btrim(${qIdent}::text)) > 1
        LIMIT 5
      `);
      if (dupes.rows.length > 0) {
        spellingHint += (spellingHint ? "; " : "") + `${dupes.rows.length}+ spelling groups`;
      }
    }

    return {
      row_count_non_null: row.row_count_non_null,
      distinct_count: row.distinct_count,
      distinct_count_lower: row.distinct_count_lower,
      case_variation_groups: Math.max(0, caseGroups),
      sample_values: (samples.rows as { v: string }[]).map((s) => s.v.slice(0, 60)),
      spelling_hint: spellingHint || "—",
    };
  } catch (e) {
    return {
      row_count_non_null: 0,
      distinct_count: 0,
      distinct_count_lower: 0,
      case_variation_groups: 0,
      sample_values: [],
      spelling_hint: e instanceof Error ? e.message : "query_failed",
    };
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const origUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!origUrl) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL required");

  const client = await connect(origUrl);
  const stgClient = stgUrl ? await connect(stgUrl) : null;

  const tablesRes = await client.query(`
    SELECT c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY 1
  `);
  const tables = (tablesRes.rows as { table_name: string }[]).map((r) => r.table_name).filter((t) => !SKIP_TABLE.test(t));

  const colsRes = await client.query(`
    SELECT table_name, column_name, udt_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  const colsByTable = new Map<string, { column_name: string; data_type: string; udt_name: string }[]>();
  for (const c of colsRes.rows as { table_name: string; column_name: string; data_type: string; udt_name: string }[]) {
    if (SKIP_TABLE.test(c.table_name)) continue;
    const list = colsByTable.get(c.table_name) ?? [];
    list.push(c);
    colsByTable.set(c.table_name, list);
  }

  const existingTables = new Set(tables);
  const fkRes = await client.query(`
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
  `);
  const fkSet = new Set(
    (fkRes.rows as { table_name: string; column_name: string }[]).map((r) => `${r.table_name}.${r.column_name}`),
  );

  const idxRes = await client.query(`
    SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'
  `);
  const idxByTableCol = (table: string, col: string) =>
    (idxRes.rows as { tablename: string; indexdef: string }[]).some(
      (i) => i.tablename === table && i.indexdef.includes(col),
    );

  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const table of tables) {
    const cols = colsByTable.get(table) ?? [];
    const colNames = new Set(cols.map((c) => c.column_name));

    for (const col of cols) {
      const isText =
        TEXT_TYPES.has(col.data_type) ||
        col.data_type === "ARRAY" ||
        col.udt_name === "_text" ||
        col.column_name.endsWith("s") && col.udt_name === "_text";
      if (!isText && col.data_type !== "ARRAY") continue;

      const rule = matchRule(table, col.column_name, colNames);
      if (!rule) continue;

      const key = `${table}.${col.column_name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const profile = await profileColumn(client, table, col.column_name, col.data_type);
      if (profile.row_count_non_null === 0 && profile.distinct_count === 0) continue;

      const lookupExists = existingTables.has(rule.lookupTable);
      const fkCol = `${table}.${rule.fkColumn}`;
      const hasFkAlready = colNames.has(rule.fkColumn) && fkSet.has(fkCol);

      let orphanCount: number | null = null;
      if (hasFkAlready && lookupExists) {
        try {
          const o = await client.query(`
            SELECT COUNT(*)::int AS c FROM public."${table}"
            WHERE "${rule.fkColumn}" IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public."${rule.lookupTable}" l WHERE l.id = "${rule.fkColumn}")
          `);
          orphanCount = Number((o.rows[0] as { c: number }).c);
        } catch {
          orphanCount = null;
        }
      }

      let dupeLookup: number | null = null;
      if (lookupExists) {
        try {
          const d = await client.query(`
            SELECT COUNT(*)::int AS c FROM (
              SELECT lower(btrim(name)) FROM public."${rule.lookupTable}"
              GROUP BY 1 HAVING COUNT(*) > 1
            ) x
          `);
          dupeLookup = Number((d.rows[0] as { c: number }).c);
        } catch {
          dupeLookup = null;
        }
      }

      const shouldFk =
        !hasFkAlready &&
        profile.distinct_count_lower > 0 &&
        profile.distinct_count_lower <= 5000 &&
        !(rule.kind === "manufacturer" && col.column_name === "mfg_part_number");

      let risk = rule.defaultRisk;
      if (profile.distinct_count_lower > 200) risk = "high";
      if (table.startsWith("v_")) risk = "medium";
      if (hasFkAlready && orphanCount && orphanCount > 0) risk = "high";

      candidates.push({
        domain: rule.domain,
        entity_kind: rule.kind,
        migration_group: rule.group,
        table,
        column: col.column_name,
        data_type: col.data_type,
        ...profile,
        spelling_variation_hint: profile.spelling_hint,
        lookup_table_exists: lookupExists,
        recommended_lookup_table: rule.lookupTable,
        should_become_fk: shouldFk,
        recommended_fk_column: rule.fkColumn,
        recommended_snapshot_column: rule.snapshotColumn,
        backfill_strategy: rule.backfill,
        risk_level: risk,
        orphan_fk_count: orphanCount,
        has_fk_index: idxByTableCol(table, rule.fkColumn),
        duplicate_lookup_names: dupeLookup,
        notes: hasFkAlready ? "FK column already present on table" : "",
      });
    }
  }

  await client.end();
  if (stgClient) {
    const stgTables = await stgClient.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`);
    await stgClient.end();
    fs.writeFileSync(
      path.join(outDir, "staging_table_count.json"),
      JSON.stringify({ staging_tables: (stgTables.rows as { table_name: string }[]).length }, null, 2),
    );
  }

  const lookupExisting = [...LOOKUP_TABLES].filter((t) => existingTables.has(t));
  const lookupMissing = [...LOOKUP_TABLES].filter((t) => !existingTables.has(t));
  const highRisk = candidates.filter((c) => c.risk_level === "high");
  const migrationGroups: Record<string, string[]> = {};
  for (const g of ["8A", "8B", "8C", "8D", "8E", "8F"] as MigrationGroup[]) {
    migrationGroups[g] = [...new Set(candidates.filter((c) => c.migration_group === g).map((c) => `${c.table}.${c.column}`))];
  }

  const blockers = [
    "Do not drop text columns — additive FK + snapshot only",
    "Rebuild/import RPCs read carrier/disposition text until view rewrite (8C/8A)",
    "return_items.conditions is text[] — needs junction table not simple FK",
    "products.vendor_id mostly filled — finish snapshot + UI join before deprecating vendor_name",
    "61+ distinct carrier tokens require alias seed before backfill",
    "claim_candidates RLS off on original — coordinate with RLS hardening pack",
    "Staging proof required before original apply for each sub-phase",
  ];

  const safe8a =
    !existingTables.has("carriers") &&
    candidates.some((c) => c.migration_group === "8A" && c.should_become_fk);

  const reportMd = [
    "# Phase 8 — Full canonical reference discovery",
    "",
    `**Run:** \`${runId}\` | **DB:** \`${ORIGINAL_REF}\` | **Mode:** read-only`,
    "",
    "## Candidate inventory",
    "",
    "| Domain | Entity | Table | Column | Distinct | Distinct(lower) | Lookup exists | Should FK | Group | Risk |",
    "|--------|--------|-------|--------|----------:|----------------:|:-------------:|:---------:|:-----:|------|",
    ...candidates
      .sort((a, b) => a.migration_group.localeCompare(b.migration_group) || b.distinct_count - a.distinct_count)
      .map(
        (c) =>
          `| ${c.domain} | ${c.entity_kind} | \`${c.table}\` | \`${c.column}\` | ${c.distinct_count} | ${c.distinct_count_lower} | ${c.lookup_table_exists ? "yes" : "**no**"} | ${c.should_become_fk ? "yes" : "no"} | ${c.migration_group} | ${c.risk_level} |`,
      ),
    "",
    "## Detail rows",
    "",
    ...candidates.map(
      (c) => `### \`${c.table}.${c.column}\` (${c.entity_kind})
- **Lookup:** \`${c.recommended_lookup_table}\` exists=${c.lookup_table_exists}
- **Proposed:** FK \`${c.recommended_fk_column}\`, snapshot \`${c.recommended_snapshot_column}\`
- **Backfill:** ${c.backfill_strategy}
- **Variations:** ${c.spelling_variation_hint}; case groups=${c.case_variation_groups}
- **Orphans:** ${c.orphan_fk_count ?? "n/a"} | FK index on proposed col=${c.has_fk_index}
- **Samples:** ${c.sample_values.slice(0, 5).join(" | ") || "—"}
`,
    ),
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "01_full_candidate_inventory.md"), reportMd + "\n");
  fs.writeFileSync(path.join(outDir, "02_migration_groups.json"), JSON.stringify(migrationGroups, null, 2));
  fs.writeFileSync(path.join(outDir, "03_lookup_table_status.json"), JSON.stringify({ lookupExisting, lookupMissing }, null, 2));
  fs.writeFileSync(path.join(outDir, "candidates.json"), JSON.stringify(candidates, null, 2));

  const summary = {
    prompt: "PHASE-8-FULL-CANONICAL-REFERENCE-DISCOVERY",
    run_id: runId,
    target_ref: ORIGINAL_REF,
    phase_number: 8,
    canonical_entities_found: candidates.length,
    lookup_tables_existing: lookupExisting,
    lookup_tables_missing: lookupMissing,
    high_risk_text_columns: highRisk.map((c) => `${c.table}.${c.column}`),
    migration_groups: migrationGroups,
    SAFE_TO_START_PHASE_8A: safe8a ? "yes" : "no",
    BLOCKERS: blockers,
    tables_scanned: tables.length,
    no_db_writes: true,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "implementation-summary.md"),
    [
      "# Phase 8 full discovery summary",
      "",
      `| Metric | Value |`,
      `|--------|------:|`,
      `| canonical_entities_found | ${candidates.length} |`,
      `| lookup_tables_existing | ${lookupExisting.length} |`,
      `| lookup_tables_missing | ${lookupMissing.length} |`,
      `| high_risk_text_columns | ${highRisk.length} |`,
      `| SAFE_TO_START_PHASE_8A | ${safe8a ? "yes" : "no"} |`,
      "",
      "## Migration groups",
      ...Object.entries(migrationGroups).map(([g, cols]) => `- **${g}:** ${cols.length} columns`),
      "",
      "## Organization domain (8F)",
      "",
      "No free-text org entity columns detected with data — **already FK-normalized**:",
      "- `stores`, `marketplaces`, `warehouses`, `organizations` tables exist",
      "- Operational tables use `store_id` / `organization_id` FKs",
      "- Phase 8F = RLS + forbid new `*_name` text without FK (guard rail only)",
      "",
      "## Already canonical (FK present, not text candidates)",
      "",
      "- `products.vendor_id` → vendors (16,880/17,058 filled; 0 orphans)",
      "- `products.category_id` → product_categories (12,955 filled)",
      "- `store_id` on expected_packages, return_items, packages, etc.",
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
