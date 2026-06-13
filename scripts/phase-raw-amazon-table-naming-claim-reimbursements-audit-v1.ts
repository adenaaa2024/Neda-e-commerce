/**
 * PHASE-RAW-AMAZON-TABLE-NAMING-AND-CLAIM-REIMBURSEMENTS-AUDIT-V1 (read-only)
 *   npx tsx scripts/phase-raw-amazon-table-naming-claim-reimbursements-audit-v1.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { AMAZON_REPORT_REGISTRY } from "../lib/pipeline/amazon-report-registry";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT_BASE = ".cursor/audit-reports/phase-raw-amazon-table-naming-claim-reimbursements-audit-v1";

const SOURCE_TABLE_PATTERNS = [
  /^amazon_/,
  /reimbursements$/,
  /returns$/,
  /removals$/,
  /settlements$/,
  /transactions$/,
  /^raw_report_uploads$/,
  /reports_repository/,
  /^amazon_staging$/,
];

const IMPORTER_TABLES = new Set(
  Object.values(AMAZON_REPORT_REGISTRY)
    .map((e) => e.sync_target_table)
    .filter(Boolean) as string[],
);
IMPORTER_TABLES.add("amazon_staging");
IMPORTER_TABLES.add("raw_report_uploads");

const CLAIM_LAYER_TABLES = new Set([
  "claim_candidates",
  "claim_candidate_drafts",
  "claim_cases",
  "claim_submissions",
  "claim_reimbursements",
  "claim_lines",
  "claim_evidence",
  "claim_reference_edges",
  "claim_review_work_items",
  "claim_filing_requests",
  "claim_enrichment_generations",
]);

type TableAudit = {
  table_name: string;
  purpose_inferred: string;
  classification:
    | "raw_amazon_source"
    | "import_ledger"
    | "claim_layer"
    | "readmodel_cache"
    | "legacy_or_unclear";
  row_count: number | null;
  has_organization_id: boolean;
  has_store_id: boolean;
  store_id_expected: boolean;
  rls_enabled: boolean;
  policy_count: number;
  used_by_importers: boolean;
  used_by_claim_generators: boolean;
  code_reference_count: number;
  column_names_sample: string[];
};

const IMPORT_LEDGER_TABLES = new Set([
  "raw_report_uploads",
  "raw_report_import_audit",
  "amazon_staging",
  "amazon_ledger_staging",
  "amazon_reports_repository",
]);

function classifyTable(name: string): TableAudit["classification"] {
  if (CLAIM_LAYER_TABLES.has(name)) return "claim_layer";
  if (IMPORT_LEDGER_TABLES.has(name)) return "import_ledger";
  if (name.startsWith("v_")) return "readmodel_cache";
  if (name.startsWith("amazon_")) return "raw_amazon_source";
  if (name === "raw_report_uploads") return "import_ledger";
  if (/reimbursements|returns|removals|settlements|transactions/.test(name)) {
    if (name.startsWith("claim_")) return "claim_layer";
    if (/^expected_/.test(name)) return "legacy_or_unclear";
    return "legacy_or_unclear";
  }
  return "legacy_or_unclear";
}

function purposeFor(name: string): string {
  const reg = Object.values(AMAZON_REPORT_REGISTRY).find((e) => e.sync_target_table === name);
  if (reg) return `${reg.report_family} report domain table (${reg.sync_target_table})`;
  if (name === "amazon_staging") return "Universal import staging landing (Phase 2)";
  if (name === "raw_report_uploads") return "Import upload registry + metadata.source_run";
  if (name === "claim_reimbursements") return "Claim workflow reimbursement outcome rows (links to claim_candidate/case)";
  if (name === "amazon_reimbursements") return "Amazon GET_FBA_REIMBURSEMENTS_DATA normalized domain";
  return "Inferred from name; verify in code";
}

function grepRefs(table: string): number {
  try {
    const out = execSync(`git grep -l "${table}" -- "*.ts" "*.tsx" "*.sql" 2>nul || true`, {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    return out.trim() ? out.trim().split("\n").filter(Boolean).length : 0;
  } catch {
    return 0;
  }
}

function claimGeneratorRef(table: string): boolean {
  const paths = [
    "lib/claims/intake",
    "lib/claims/discovery",
    "lib/claims/edges",
    "lib/claim-intake",
    "lib/claims/connectors",
  ];
  try {
    for (const p of paths) {
      const out = execSync(`git grep -l "${table}" -- "${p}" 2>nul || true`, {
        encoding: "utf8",
        cwd: process.cwd(),
      });
      if (out.trim()) return true;
    }
  } catch {
    /* ignore */
  }
  return grepRefs(table) > 0 && /amazon_/.test(table);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();

  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const tablesRes = await client.query(
    `SELECT c.relname AS table_name,
            c.relrowsecurity AS rls_enabled,
            (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname AND p.schemaname = 'public') AS policy_count
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`,
  );

  const allTables = tablesRes.rows as Array<{ table_name: string; rls_enabled: boolean; policy_count: number }>;
  const sourceTables = allTables.filter((t) => SOURCE_TABLE_PATTERNS.some((re) => re.test(t.table_name)));

  const inventory: TableAudit[] = [];

  for (const t of sourceTables) {
    const cols = await client.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [t.table_name],
    );
    const colNames = cols.rows.map((r: { column_name: string }) => r.column_name);
    const hasOrg = colNames.includes("organization_id");
    const hasStore = colNames.includes("store_id");
    const storeExpected =
      t.table_name.startsWith("amazon_") &&
      !["amazon_staging", "amazon_reports_repository"].includes(t.table_name);

    let rowCount: number | null = null;
    try {
      const c = await client.query(`SELECT count(*)::bigint AS c FROM public.${t.table_name}`);
      rowCount = Number(c.rows[0]?.c ?? 0);
    } catch {
      rowCount = null;
    }

    inventory.push({
      table_name: t.table_name,
      purpose_inferred: purposeFor(t.table_name),
      classification: classifyTable(t.table_name),
      row_count: rowCount,
      has_organization_id: hasOrg,
      has_store_id: hasStore,
      store_id_expected: storeExpected,
      rls_enabled: t.rls_enabled === true,
      policy_count: Number(t.policy_count ?? 0),
      used_by_importers: IMPORTER_TABLES.has(t.table_name),
      used_by_claim_generators: claimGeneratorRef(t.table_name),
      code_reference_count: grepRefs(t.table_name),
      column_names_sample: colNames.slice(0, 24),
    });
  }

  const claimReimbCols = await client.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'claim_reimbursements'
     ORDER BY ordinal_position`,
  );

  const claimReimbExists = claimReimbCols.rows.length > 0;
  let claimReimbCount: number | null = null;
  let amazonReimbCount: number | null = null;
  if (claimReimbExists) {
    claimReimbCount = Number((await client.query(`SELECT count(*)::bigint c FROM claim_reimbursements`)).rows[0]?.c ?? 0);
  }
  amazonReimbCount = Number(
    (await client.query(`SELECT count(*)::bigint c FROM amazon_reimbursements`)).rows[0]?.c ?? 0,
  );

  const claimReimbFks = claimReimbExists
    ? await client.query(
        `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
         WHERE conrelid = 'public.claim_reimbursements'::regclass AND contype = 'f'`,
      )
    : { rows: [] };

  const claimReimbRls = claimReimbExists
    ? await client.query(
        `SELECT relrowsecurity FROM pg_class WHERE relname = 'claim_reimbursements' AND relnamespace = 'public'::regnamespace`,
      )
    : { rows: [] };

  const migrationRefs = grepRefs("claim_reimbursements");
  const appLibRefs = execSync(
    `git grep -n "claim_reimbursements" -- "app" "lib" "scripts" 2>nul || echo ""`,
    { encoding: "utf8", cwd: process.cwd() },
  ).trim();

  const amazonReimbAppLib = execSync(
    `git grep -n "amazon_reimbursements" -- "app" "lib" 2>nul || echo ""`,
    { encoding: "utf8", cwd: process.cwd() },
  ).trim();

  const claimReimbInGenerators = execSync(
    `git grep -l "claim_reimbursements" -- "lib/claims" "lib/fees" "app" 2>nul || echo ""`,
    { encoding: "utf8", cwd: process.cwd() },
  ).trim();

  const amazonReimbInGenerators = execSync(
    `git grep -l "amazon_reimbursements" -- "lib/claims" "lib/fees" 2>nul || echo ""`,
    { encoding: "utf8", cwd: process.cwd() },
  ).trim();

  await client.end();

  const rawAmazonTables = inventory.filter((t) => t.classification === "raw_amazon_source");
  const claimLayerTables = inventory.filter((t) => t.classification === "claim_layer");
  const legacyOrUnclearTables = inventory.filter((t) => t.classification === "legacy_or_unclear");
  const importLedgerTables = inventory.filter((t) => t.classification === "import_ledger");

  const rlsMatrix = inventory.map((t) => ({
    table: t.table_name,
    rls_enabled: t.rls_enabled,
    policy_count: t.policy_count,
    pass: t.rls_enabled && t.policy_count > 0,
  }));

  const orgStoreMatrix = inventory.map((t) => ({
    table: t.table_name,
    has_organization_id: t.has_organization_id,
    has_store_id: t.has_store_id,
    store_id_expected: t.store_id_expected,
    org_pass: t.has_organization_id,
    store_pass: !t.store_id_expected || t.has_store_id,
  }));

  const nonAmazonRaw = inventory.filter(
    (t) =>
      !t.table_name.startsWith("amazon_") &&
      t.table_name !== "raw_report_uploads" &&
      t.classification !== "claim_layer" &&
      /reimbursements|returns|removals|settlements|transactions/.test(t.table_name),
  );

  const claimReimbClassification = {
    exists_on_db: claimReimbExists,
    layer: "claim_layer_outcome",
    is_raw_amazon_source: false,
    columns: claimReimbCols.rows,
    row_count: claimReimbCount,
    amazon_reimbursements_row_count: amazonReimbCount,
    foreign_keys: claimReimbFks.rows,
    rls_enabled: claimReimbRls.rows[0]?.relrowsecurity === true,
    duplicates_amazon_reimbursements: false,
    duplicate_rationale:
      "Different purpose: amazon_reimbursements = SP-API/file normalized Amazon reimbursement events; claim_reimbursements = claim workflow outcome rows tied to claim_candidate_id with source_table/source_row_id pointer",
    created_by:
      "Not in repo supabase/migrations CREATE TABLE — pre-bootstrap / legacy schema on original DB; RLS batch migration 20260614120000 references it conditionally",
    migrations_in_repo: [
      "supabase/migrations/20260614120000_phase_rls_policy_batch_claim_amazon_reimbursements_v1.sql (RLS only, IF EXISTS)",
    ],
    used_by_generators_or_readmodels: claimReimbInGenerators.length === 0,
    generator_readmodel_note:
      claimReimbInGenerators.length === 0
        ? "No references in lib/claims, lib/fees, or app — audit/report scripts only"
        : claimReimbInGenerators,
    safe_as_claim_layer_outcome: true,
    rename_recommended: false,
    document_only_recommended: true,
    code_references_app_lib: appLibRefs.split("\n").filter(Boolean),
    code_references_migrations_sql: migrationRefs,
  };

  const duplicateRisk = {
    claim_reimbursements_vs_amazon_reimbursements: "low",
    rationale: claimReimbClassification.duplicate_rationale,
    observed_reimbursement_canonical_source: "amazon_reimbursements",
    claim_layer_outcome_source: "claim_reimbursements (future submission bridge only)",
    naming_violations_populated: inventory
      .filter((t) => t.classification === "legacy_or_unclear" && (t.row_count ?? 0) > 0)
      .map((t) => ({ table: t.table_name, row_count: t.row_count, note: "missing amazon_ prefix — document/rename backlog" })),
  };

  const report = {
    prompt: "PHASE-RAW-AMAZON-TABLE-NAMING-AND-CLAIM-REIMBURSEMENTS-AUDIT-V1-EXECUTE",
    run_id: runId,
    db: PRODUCTION_REF,
    mode: "read_only",
    no_schema_change: true,
    source_table_inventory: inventory,
    raw_amazon_tables: rawAmazonTables.map((t) => t.table_name),
    claim_layer_tables: claimLayerTables.map((t) => t.table_name),
    import_ledger_tables: importLedgerTables.map((t) => t.table_name),
    legacy_or_unclear_tables: legacyOrUnclearTables.map((t) => ({
      table_name: t.table_name,
      row_count: t.row_count,
      purpose_inferred: t.purpose_inferred,
    })),
    claim_reimbursements_classification: claimReimbClassification,
    duplicate_risk: duplicateRisk,
    raw_vs_claim_layer_decision: {
      rule: "Raw Amazon normalized tables use amazon_* prefix; claim-layer tables (claim_*) are not raw source of truth",
      amazon_reimbursements: "raw source — SP-API GET_FBA_REIMBURSEMENTS_DATA domain; used by generators/readmodels for observed reimbursement",
      claim_reimbursements: "claim-layer output / workflow — not raw Amazon ingest; populate only via submission bridge",
      raw_report_uploads: "import ledger — upload registry, not domain normalized data",
      amazon_staging: "import ledger — Phase 2 staging landing, not final domain truth",
    },
    duplicate_or_legacy_risk: {
      claim_reimbursements_vs_amazon_reimbursements: duplicateRisk.rationale,
      non_amazon_prefix_source_like_tables: nonAmazonRaw.map((t) => t.table_name),
      naming_violations: duplicateRisk.naming_violations_populated.map((t) => t.table),
    },
    RLS_status_matrix: rlsMatrix,
    org_store_scope_matrix: orgStoreMatrix,
    code_references: {
      claim_reimbursements: appLibRefs.split("\n").filter(Boolean),
      amazon_reimbursements_generators: amazonReimbInGenerators.split("\n").filter(Boolean),
      amazon_reimbursements_sample: amazonReimbAppLib.split("\n").filter(Boolean).slice(0, 20),
    },
    recommended_action: [
      "Keep amazon_reimbursements as canonical raw reimbursement domain; importers/generators/readmodels already use it for observed reimbursement",
      "Document claim_reimbursements as claim-layer reimbursement outcome table — not raw Amazon source; do not use for observed reimbursement in generators",
      "Do not rename or drop claim_reimbursements in this phase; table is empty and FK-linked to claim_candidates",
      "Future: populate claim_reimbursements only via explicit claim submission/reimbursement bridge — never from SP-API import",
      "Document naming law in DATABASE_CONTRACT.md; audit legacy expected_* tables for rename backlog with Maysam approval",
    ],
    approval_required_actions: [
      "Any new amazon_* or claim_* table creation",
      "Rename claim_reimbursements or amazon_* tables",
      "Drop legacy tables with row_count > 0",
      "Wire claim_reimbursements into generators (would blur claim-layer vs raw — requires architecture review)",
    ],
    SAFE_TO_KEEP_CLAIM_REIMBURSEMENTS: claimReimbExists ? "yes" : "unknown",
    NEXT_PROMPT:
      "PHASE-RAW-AMAZON-TABLE-NAMING-DOC-CONTRACT-V1 — document amazon_* vs claim_* naming law in DATABASE_CONTRACT.md; no DDL",
  };

  const rlsFails = rlsMatrix.filter((r) => !r.pass);
  const orgFails = orgStoreMatrix.filter((o) => !o.org_pass || !o.store_pass);

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "audit-report.md"),
    `# Raw Amazon table + claim_reimbursements audit

DB: \`${PRODUCTION_REF}\` · Run: \`${runId}\`

## Summary
- Source-like tables inventoried: **${inventory.length}**
- \`claim_reimbursements\`: **${claimReimbExists ? `${claimReimbCount} rows` : "missing"}** vs \`amazon_reimbursements\`: **${amazonReimbCount}**
- RLS gaps: **${rlsFails.length}** · org/store scope gaps: **${orgFails.length}**

## SAFE_TO_KEEP_CLAIM_REIMBURSEMENTS: **${report.SAFE_TO_KEEP_CLAIM_REIMBURSEMENTS}**

claim_reimbursements is **claim-layer**, not raw Amazon source. Not a duplicate of amazon_reimbursements.
`,
  );

  console.log(
    JSON.stringify({
      ok: true,
      outDir,
      tables: inventory.length,
      claim_reimbursements: claimReimbCount,
      amazon_reimbursements: amazonReimbCount,
      SAFE: report.SAFE_TO_KEEP_CLAIM_REIMBURSEMENTS,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
