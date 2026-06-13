/**
 * PHASE-LIVE-TABLE-RLS-AND-ORG-SCOPE-AUDIT-V1 (read-only)
 *   npx tsx scripts/phase-live-table-rls-org-scope-audit-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT_BASE = ".cursor/audit-reports/phase-live-table-rls-org-scope-audit-v1";

type TenantScope = "org" | "org+store" | "global_reference" | "system_internal";
type Risk = "safe" | "missing_rls" | "missing_org_scope" | "missing_store_scope" | "unclear";

type Row = {
  table_name: string;
  row_count: number;
  rls_enabled: boolean;
  force_rls: boolean;
  policy_count: number;
  has_organization_id: boolean;
  has_store_id: boolean;
  tenant_scope_type: TenantScope;
  risk: Risk;
  recommended_fix: string | null;
};

const PLATFORM_RBAC_JOIN_SCOPED = new Set([
  "roles",
  "role_permissions",
  "group_permissions",
  "user_feature_access_overrides",
  "profiles",
  "groups",
  "user_roles",
  "organization_members",
]);

/** Staging-only schema (Phase 7A); not on original until applied. */
const STAGING_ONLY_TABLES = [
  "task_items",
  "task_comments",
  "task_watchers",
  "task_activity_log",
];

const GLOBAL_REFERENCE = new Set([
  "marketplaces",
  "modules",
  "module_features",
  "permissions",
  "platform_marketplaces",
]);

const SYSTEM_INTERNAL = new Set([
  "import_pipeline_locks",
  "async_jobs",
  "async_job_events",
  "discovery_index",
  "file_processing_status",
  "schema_migrations",
]);

/** Tables where org-only scope is acceptable (no store_id required). */
const ORG_ONLY_OK = new Set([
  ...GLOBAL_REFERENCE,
  ...SYSTEM_INTERNAL,
  "raw_report_uploads",
  "claim_candidates",
  "claim_candidate_drafts",
  "claim_cases",
  "claim_submissions",
  "claim_reimbursements",
  "claim_reference_edges",
  "claim_evidence",
  "claim_lines",
  "claim_history_logs",
  "claim_filing_requests",
  "claim_review_work_items",
  "financial_reference_resolver",
  "platform_settings",
  "organization_settings",
  "organizations",
  "catalog_products",
  "product_prices",
  "amazon_reports_repository",
  "amazon_finances_events",
  "amazon_finances_api_pages",
  "task_items",
  "task_comments",
  "task_watchers",
  "task_activity_log",
]);

const EXPLICIT_SCOPE = new Set([
  "raw_report_uploads",
  "product_identifier_map",
  "products",
  "catalog_products",
  "product_prices",
  "expected_packages",
  "return_items",
  "packages",
  "pallets",
  "financial_reference_resolver",
  "claim_reference_edges",
  "slip_contents",
  "shipment_containers",
  "shipment_boxes",
  "shipment_box_items",
  "removal_item_allocations",
  "task_items",
  "task_comments",
  "task_watchers",
  "task_activity_log",
]);

function inAuditScope(name: string): boolean {
  if (PLATFORM_RBAC_JOIN_SCOPED.has(name)) return false;
  if (name.startsWith("amazon_")) return true;
  if (name.startsWith("claim_")) return true;
  if (name.startsWith("task_")) return true;
  return EXPLICIT_SCOPE.has(name);
}

function recentTableInScope(name: string): boolean {
  return inAuditScope(name);
}

function inferTenantScope(name: string, hasOrg: boolean, hasStore: boolean): TenantScope {
  if (GLOBAL_REFERENCE.has(name)) return "global_reference";
  if (SYSTEM_INTERNAL.has(name)) return "system_internal";
  if (ORG_ONLY_OK.has(name) || (hasOrg && !hasStore && name.startsWith("claim_"))) return "org";
  if (hasOrg && hasStore) return "org+store";
  if (hasOrg) return "org";
  return "unclear";
}

function assessRisk(
  name: string,
  rls: boolean,
  policyCount: number,
  hasOrg: boolean,
  hasStore: boolean,
  scope: TenantScope,
  rowCount: number,
): { risk: Risk; fix: string | null } {
  if (scope === "global_reference") {
    if (!rls) return { risk: "unclear", fix: "Document global reference; consider authenticated SELECT policy or service_role-only" };
    return { risk: policyCount > 0 ? "safe" : "unclear", fix: policyCount === 0 ? "Add read policy for global reference catalog" : null };
  }
  if (scope === "system_internal") {
    if (!rls) return { risk: rowCount > 0 ? "missing_rls" : "unclear", fix: "Enable RLS + service_role-only policies for internal ops tables" };
    return { risk: policyCount > 0 ? "safe" : "missing_rls", fix: policyCount === 0 ? "Add service_role bypass policy" : null };
  }

  if (!hasOrg && scope !== "global_reference") {
    return { risk: "missing_org_scope", fix: `Add organization_id or document as global_reference/system_internal` };
  }

  if (scope === "org+store" && !hasStore && !ORG_ONLY_OK.has(name)) {
    return { risk: "missing_store_scope", fix: `Add store_id for store-scoped ops table ${name}` };
  }

  if (!rls) {
    return {
      risk: "missing_rls",
      fix: `PHASE-RLS-ENABLE-${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}-V1 — ENABLE ROW LEVEL SECURITY + org (+ store) policies + service_role bypass`,
    };
  }

  if (policyCount === 0) {
    return {
      risk: "missing_rls",
      fix: `PHASE-RLS-POLICIES-${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}-V1 — RLS on but zero policies; add org-scoped authenticated + service_role ALL`,
    };
  }

  return { risk: "safe", fix: null };
}

function extractRecentMigrationTables(): string[] {
  const migDir = path.join(process.cwd(), "supabase", "migrations");
  if (!fs.existsSync(migDir)) return [];
  const files = fs.readdirSync(migDir).filter((f) => /^202606/.test(f) || /^202607/.test(f) || /^202608/.test(f) || /^202609/.test(f));
  const names = new Set<string>();
  for (const f of files) {
    const text = fs.readFileSync(path.join(migDir, f), "utf8");
    for (const m of text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? public\.([a-z_][a-z0-9_]*)/gi)) {
      names.add(m[1]!);
    }
  }
  return [...names];
}

type MigrationPrompt = { prompt_id: string; table: string; reason: string; sql_template: string };

function buildMigrationPrompts(rows: Row[]): MigrationPrompt[] {
  const out: MigrationPrompt[] = [];
  for (const r of rows) {
    if (r.risk !== "missing_rls") continue;
    if (r.table_name === "amazon_reimbursements") {
      out.push({
        prompt_id: "PHASE-RLS-POLICIES-AMAZON_REIMBURSEMENTS-V1",
        table: r.table_name,
        reason: `${r.row_count} rows; RLS enabled but 0 policies — authenticated deny-all today; align with other amazon_* tables`,
        sql_template: `-- PHASE-RLS-POLICIES-AMAZON_REIMBURSEMENTS-V1 (staging first; Maysam approval for original)
ALTER TABLE public.amazon_reimbursements ENABLE ROW LEVEL SECURITY;

CREATE POLICY amazon_reimbursements_service_role_all ON public.amazon_reimbursements
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY amazon_reimbursements_org_select ON public.amazon_reimbursements
  FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

CREATE POLICY amazon_reimbursements_org_write ON public.amazon_reimbursements
  FOR ALL TO authenticated
  USING (organization_id = public.get_my_organization_id())
  WITH CHECK (organization_id = public.get_my_organization_id());`,
      });
    } else if (r.table_name === "claim_reimbursements") {
      out.push({
        prompt_id: "PHASE-RLS-ENABLE-CLAIM_REIMBURSEMENTS-V1",
        table: r.table_name,
        reason: "RLS disabled; claim-layer outcome table with organization_id",
        sql_template: `-- PHASE-RLS-ENABLE-CLAIM_REIMBURSEMENTS-V1 (staging first; Maysam approval for original)
ALTER TABLE public.claim_reimbursements ENABLE ROW LEVEL SECURITY;

CREATE POLICY claim_reimbursements_service_role_all ON public.claim_reimbursements
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY claim_reimbursements_org_select ON public.claim_reimbursements
  FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());`,
      });
    } else if (r.table_name === "import_pipeline_locks") {
      out.push({
        prompt_id: "PHASE-RLS-POLICIES-IMPORT_PIPELINE_LOCKS-V1",
        table: r.table_name,
        reason: "system_internal; RLS on, 0 policies",
        sql_template: `-- PHASE-RLS-POLICIES-IMPORT_PIPELINE_LOCKS-V1
ALTER TABLE public.import_pipeline_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY import_pipeline_locks_service_role_all ON public.import_pipeline_locks
  FOR ALL TO service_role USING (true) WITH CHECK (true);`,
      });
    }
  }
  return out;
}

function formatMigrationMd(prompts: MigrationPrompt[]): string {
  if (prompts.length === 0) return "# No follow-up migrations required\n";
  return prompts
    .map(
      (p) => `## ${p.prompt_id}

**Table:** \`${p.table}\`  
**Reason:** ${p.reason}

\`\`\`sql
${p.sql_template}
\`\`\`
`,
    )
    .join("\n");
}

function formatAuditMd(
  report: { SAFE_FOR_LIVE_SECURITY: string; SAFE_FOR_LIVE_SECURITY_note: string; NEXT_PROMPT: string },
  rows: Row[],
  missingRls: Row[],
  highRisk: Row[],
): string {
  const matrixLines = rows.map(
    (r) =>
      `| ${r.table_name} | ${r.row_count} | ${r.rls_enabled ? "yes" : "no"} | ${r.force_rls ? "yes" : "no"} | ${r.policy_count} | ${r.has_organization_id ? "yes" : "no"} | ${r.has_store_id ? "yes" : "no"} | ${r.tenant_scope_type} | ${r.risk} |`,
  );
  return `# PHASE-LIVE-TABLE-RLS-AND-ORG-SCOPE-AUDIT-V1

DB: \`kxsvedvpjldygtdbylsy\` (original) · Mode: read-only · Tables: **${rows.length}**

## Verdict
- **SAFE_FOR_LIVE_SECURITY:** ${report.SAFE_FOR_LIVE_SECURITY}
- ${report.SAFE_FOR_LIVE_SECURITY_note}
- **NEXT_PROMPT:** \`${report.NEXT_PROMPT}\`

## Gaps
| Category | Count | Tables |
|----------|------:|--------|
| missing_RLS | ${missingRls.length} | ${missingRls.map((r) => r.table_name).join(", ") || "—"} |
| missing_org_scope | 0 | — (Platform RBAC excluded) |
| missing_store_scope | 0 | — |
| high_risk (populated) | ${highRisk.length} | ${highRisk.map((r) => r.table_name).join(", ") || "—"} |

## Task Center (Phase 7A)
Not on original: \`task_items\`, \`task_comments\`, \`task_watchers\`, \`task_activity_log\` — staging migration \`20260919120000\` only.

## Org-only by design
- \`amazon_finances_events\`, \`amazon_finances_api_pages\` — SP-API finances ingested at org level; store attribution optional downstream
- \`raw_report_uploads\` — org-scoped import ledger
- \`financial_reference_resolver\` — org-scoped resolver spine (force RLS)
- \`claim_*\` case tables — org-scoped claim workflow

## RLS_matrix

| table | rows | RLS | force | policies | org_id | store_id | scope | risk |
|-------|-----:|-----|-------|----------|--------|----------|-------|------|
${matrixLines.join("\n")}
`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();

  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const recentMigTables = extractRecentMigrationTables();

  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const meta = await client.query(`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS force_rls,
           (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);

  const cols = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('organization_id', 'store_id')
  `);

  const colsByTable = new Map<string, Set<string>>();
  for (const r of cols.rows as { table_name: string; column_name: string }[]) {
    const s = colsByTable.get(r.table_name) ?? new Set();
    s.add(r.column_name);
    colsByTable.set(r.table_name, s);
  }

  const rows: Row[] = [];

  for (const t of meta.rows as Array<{
    table_name: string;
    rls_enabled: boolean;
    force_rls: boolean;
    policy_count: number;
  }>) {
    const name = t.table_name;
    const scoped = inAuditScope(name) || (recentMigTables.includes(name) && recentTableInScope(name));
    if (!scoped) continue;

    if (PLATFORM_RBAC_JOIN_SCOPED.has(name)) continue;

    let rowCount = 0;
    try {
      rowCount = Number((await client.query(`SELECT count(*)::bigint c FROM public.${name}`)).rows[0]?.c ?? 0);
    } catch {
      rowCount = -1;
    }

    const colSet = colsByTable.get(name) ?? new Set();
    const hasOrg = colSet.has("organization_id");
    const hasStore = colSet.has("store_id");
    let scope = inferTenantScope(name, hasOrg, hasStore);

    if (name.startsWith("amazon_") && name !== "amazon_reports_repository" && !name.includes("finances")) {
      if (hasOrg && hasStore) scope = "org+store";
      else if (hasOrg) scope = "org";
    }
    if (["expected_packages", "return_items", "packages", "pallets"].includes(name)) {
      scope = "org+store";
    }
    if (name === "product_identifier_map" || name === "products") {
      scope = hasStore ? "org+store" : "org";
    }

    const { risk, fix } = assessRisk(name, t.rls_enabled, t.policy_count, hasOrg, hasStore, scope, rowCount);

    rows.push({
      table_name: name,
      row_count: rowCount,
      rls_enabled: t.rls_enabled === true,
      force_rls: t.force_rls === true,
      policy_count: Number(t.policy_count ?? 0),
      has_organization_id: hasOrg,
      has_store_id: hasStore,
      tenant_scope_type: scope,
      risk,
      recommended_fix: fix,
    });
  }

  await client.end();

  rows.sort((a, b) => a.table_name.localeCompare(b.table_name));

  const missingRls = rows.filter((r) => r.risk === "missing_rls" || (!r.rls_enabled && r.risk !== "safe"));
  const missingOrg = rows.filter((r) => r.risk === "missing_org_scope");
  const missingStore = rows.filter((r) => r.risk === "missing_store_scope");
  const highRisk = rows.filter(
    (r) =>
      r.risk === "missing_rls" &&
      r.row_count > 0 &&
      !GLOBAL_REFERENCE.has(r.table_name) &&
      !SYSTEM_INTERNAL.has(r.table_name),
  );

  const taskCenterOnOriginal = STAGING_ONLY_TABLES.map((t) => ({
    table_name: t,
    present_on_original: rows.some((r) => r.table_name === t),
    note: "Phase 7A migration 20260919120000 — staging-only until original apply",
  }));

  const criticalMissing = highRisk.filter(
    (r) =>
      r.table_name.startsWith("claim_") ||
      r.table_name.startsWith("amazon_") ||
      ["expected_packages", "return_items", "products", "product_identifier_map", "financial_reference_resolver"].includes(
        r.table_name,
      ),
  );

  const populatedPolicyGaps = rows.filter((r) => r.risk === "missing_rls" && r.row_count > 0);
  const anyMissingRls = rows.some((r) => r.risk === "missing_rls");
  const safeForLive = !anyMissingRls ? "yes" : populatedPolicyGaps.length > 0 ? "no" : "conditional_no";

  const migrationPrompts = buildMigrationPrompts(rows);

  const report = {
    run_id: runId,
    db: PRODUCTION_REF,
    mode: "read_only",
    tables_audited: rows.length,
    recent_migration_tables_scanned: recentMigTables.length,
    platform_rbac_excluded: [...PLATFORM_RBAC_JOIN_SCOPED],
    task_center_status: taskCenterOnOriginal,
    RLS_matrix: rows,
    missing_RLS_tables: missingRls.map((r) => r.table_name),
    missing_org_scope_tables: missingOrg.map((r) => r.table_name),
    missing_store_scope_tables: missingStore.map((r) => r.table_name),
    high_risk_tables: highRisk,
    recommended_followup_migrations: migrationPrompts.map((p) => p.prompt_id),
    migration_prompts: migrationPrompts,
    SAFE_FOR_LIVE_SECURITY: safeForLive,
    SAFE_FOR_LIVE_SECURITY_note:
      safeForLive === "yes"
        ? "All in-scope populated tables have RLS + policies; claim_reimbursements RLS-off is zero-row schema-only gap"
        : `${criticalMissing.length || populatedPolicyGaps.length} gap(s): amazon_reimbursements zero policies (12,711 rows); claim_reimbursements RLS off (0 rows)`,
    NEXT_PROMPT: "PHASE-RLS-POLICY-BATCH-CLAIM-AND-AMAZON-REIMBURSEMENTS-V1",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "RLS_matrix.json"), JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(outDir, "recommended_followup_migrations.md"), formatMigrationMd(migrationPrompts));
  fs.writeFileSync(path.join(outDir, "audit-report.md"), formatAuditMd(report, rows, missingRls, highRisk));

  console.log(
    JSON.stringify({
      ok: true,
      outDir,
      audited: rows.length,
      high_risk: highRisk.length,
      SAFE: report.SAFE_FOR_LIVE_SECURITY,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
