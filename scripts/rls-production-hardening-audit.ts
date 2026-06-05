/**
 * PRODUCTION_RLS_HARDENING_AUDIT_AND_PHASED_PLAN (read-only)
 * Target: original/live kxsvedvpjldygtdbylsy
 *
 *   npx tsx scripts/rls-production-hardening-audit.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/rls-production-hardening";

type ClassLetter = "A" | "B" | "C" | "D" | "E" | "F";
type AccessPattern =
  | "public_client"
  | "authenticated_user"
  | "admin"
  | "service_role_only"
  | "scanner_operator"
  | "cron_import_worker"
  | "internal_rpc_only";

type TableAudit = {
  table: string;
  rls_enabled: boolean;
  policy_count: number;
  policies: string[];
  row_estimate: number | null;
  has_organization_id: boolean;
  has_store_id: boolean;
  has_user_owner: boolean;
  high_risk: boolean;
  access_patterns: AccessPattern[];
  app_surfaces: string[];
  classification: ClassLetter;
  phase: 0 | 1 | 2 | 3 | 4 | "storage" | "skip";
  notes: string;
};

const SENSITIVE_TABLES = new Set([
  "organization_api_keys",
  "marketplaces",
  "amazon_sp_api_credentials",
  "amazon_reports_api_credentials",
  "platform_secrets",
  "system_settings",
  "import_credentials",
]);

const SERVICE_ROLE_ONLY = new Set([
  "amazon_staging",
  "file_processing_status",
  "financial_reference_resolver",
  "removal_item_allocations",
  "async_jobs",
  "async_job_events",
  "import_run_state",
  "platform_automation_import_runs",
]);

const SCANNER_TABLES = new Set([
  "packages",
  "pallets",
  "return_items",
  "slip_contents",
  "expected_packages",
  "v_inventory_item_status",
]);

const CLAIMS_TABLES = new Set([
  "claim_candidates",
  "claim_candidate_drafts",
  "claim_lines",
  "claim_reference_edges",
  "claim_filing_requests",
  "claim_filing_request_events",
  "claim_submissions",
  "claim_evidence_draft_operator_state",
  "claim_reference_edge_bulk_review_events",
]);

const PHASE1_SAFE = new Set([
  "permissions",
  "role_permissions",
  "group_permissions",
  "roles",
  "pim_duplicate_groups",
  "pim_conflict_audit_log",
  "pim_import_sessions",
  "catalog_products",
  "catalog_listing_rows_raw",
]);

const MANUAL_CLASS: Record<
  string,
  Partial<Pick<TableAudit, "classification" | "phase" | "high_risk" | "access_patterns" | "notes">>
> = {
  products: {
    classification: "B",
    phase: 2,
    access_patterns: ["authenticated_user", "scanner_operator", "service_role_only"],
    notes: "RLS may exist on original; verify store-scoped reads for scanner. Server actions use service role.",
  },
  product_identifier_map: {
    classification: "B",
    phase: 2,
    high_risk: true,
    access_patterns: ["authenticated_user", "scanner_operator", "cron_import_worker", "service_role_only"],
    notes: "Org+store scoped; resolver reads in scanner. Import workers bulk upsert via service role.",
  },
  product_prices: { classification: "A", phase: 1, access_patterns: ["authenticated_user", "service_role_only"] },
  vendors: { classification: "A", phase: 1, access_patterns: ["authenticated_user", "service_role_only"] },
  product_categories: { classification: "A", phase: 1, access_patterns: ["authenticated_user", "service_role_only"] },
  expected_packages: {
    classification: "B",
    phase: 2,
    access_patterns: ["scanner_operator", "authenticated_user", "cron_import_worker", "service_role_only"],
    notes: "Rebuild RPC + scanner hydration; needs org+optional store policy helper.",
  },
  return_items: {
    classification: "B",
    phase: 2,
    access_patterns: ["scanner_operator", "authenticated_user", "service_role_only"],
    notes: "Scanner item-actions write path; must not break operator mobile.",
  },
  packages: { classification: "B", phase: 2, access_patterns: ["scanner_operator", "service_role_only"] },
  pallets: { classification: "B", phase: 2, access_patterns: ["scanner_operator", "service_role_only"] },
  slip_contents: { classification: "B", phase: 2, access_patterns: ["scanner_operator", "service_role_only"] },
  amazon_removals: {
    classification: "C",
    phase: 0,
    access_patterns: ["cron_import_worker", "service_role_only"],
    notes: "Domain ingest; client reads via views/RPC preferred.",
  },
  amazon_removal_shipments: {
    classification: "C",
    phase: 0,
    access_patterns: ["cron_import_worker", "service_role_only"],
  },
  raw_report_uploads: {
    classification: "C",
    phase: 0,
    access_patterns: ["admin", "cron_import_worker", "service_role_only"],
  },
  organization_api_keys: {
    classification: "E",
    phase: 4,
    high_risk: true,
    access_patterns: ["admin", "service_role_only"],
    notes: "Never expose secret material to anon/authenticated SELECT.",
  },
  marketplaces: {
    classification: "E",
    phase: 4,
    high_risk: true,
    access_patterns: ["admin", "service_role_only"],
    notes: "May contain SP-API tokens; column-level redaction or service-role-only reads.",
  },
  audit_events: {
    classification: "B",
    phase: 3,
    access_patterns: ["authenticated_user", "admin", "service_role_only"],
    notes: "Org-scoped audit read; append via SECURITY DEFINER RPC.",
  },
  undo_snapshots: {
    classification: "B",
    phase: 3,
    high_risk: true,
    access_patterns: ["admin", "service_role_only"],
    notes: "Contains deleted entity JSON; restrict to admin/service role.",
  },
  profiles: { classification: "A", phase: 1, access_patterns: ["authenticated_user", "service_role_only"] },
  organizations: { classification: "A", phase: 1, access_patterns: ["authenticated_user"] },
  stores: { classification: "A", phase: 1, access_patterns: ["authenticated_user", "scanner_operator"] },
  user_store_assignments: {
    classification: "A",
    phase: 1,
    access_patterns: ["authenticated_user", "scanner_operator"],
    notes: "Foundation for store-scoped scanner RLS.",
  },
  platform_settings: {
    classification: "D",
    phase: 1,
    access_patterns: ["authenticated_user", "scanner_operator"],
    notes: "Singleton PWA settings; authenticated read OK, no anon.",
  },
  workspace_settings: {
    classification: "F",
    phase: 0,
    access_patterns: ["authenticated_user"],
    notes: "Current policy allows any authenticated user ALL — needs admin gate before tightening.",
  },
  returns: {
    classification: "F",
    phase: 0,
    access_patterns: ["service_role_only"],
    notes: "FORBIDDEN: app must not query .from(returns). Legacy table.",
  },
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

function scanCodebaseForTable(table: string): string[] {
  const surfaces: string[] = [];
  const patterns = [
    `.from("${table}")`,
    `.from('${table}')`,
    `from("${table}")`,
    `public.${table}`,
    `"${table}"`,
  ];
  const dirs = ["app", "lib", "components", "scripts"];
  for (const dir of dirs) {
    const abs = path.join(process.cwd(), dir);
    if (!fs.existsSync(abs)) continue;
    try {
      const out = execSync(`rg -l --glob "*.{ts,tsx,py}" "${table}" "${abs}"`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      if (out) {
        for (const f of out.split("\n").slice(0, 8)) {
          surfaces.push(path.relative(process.cwd(), f).replace(/\\/g, "/"));
        }
      }
    } catch {
      /* no matches */
    }
  }
  return [...new Set(surfaces)].slice(0, 8);
}

function isBackupTable(table: string): boolean {
  return table.startsWith("_backup_") || table.startsWith("backup_");
}

function classifyTable(
  table: string,
  rls: boolean,
  policyCount: number,
  hasOrg: boolean,
  hasStore: boolean,
): Pick<TableAudit, "classification" | "phase" | "high_risk" | "access_patterns" | "notes"> {
  if (isBackupTable(table)) {
    return {
      classification: "C",
      phase: 0,
      high_risk: false,
      access_patterns: ["service_role_only"],
      notes: "Operator backup table — revoke authenticated grants; service_role only or drop after retention.",
    };
  }
  if (MANUAL_CLASS[table]) {
    const m = MANUAL_CLASS[table]!;
    return {
      classification: m.classification ?? "B",
      phase: m.phase ?? 0,
      high_risk: m.high_risk ?? SENSITIVE_TABLES.has(table),
      access_patterns: m.access_patterns ?? ["service_role_only"],
      notes: m.notes ?? "",
    };
  }
  if (SENSITIVE_TABLES.has(table)) {
    return {
      classification: "E",
      phase: 4,
      high_risk: true,
      access_patterns: ["admin", "service_role_only"],
      notes: "Sensitive credentials/secrets.",
    };
  }
  if (SERVICE_ROLE_ONLY.has(table)) {
    return {
      classification: "C",
      phase: 0,
      high_risk: false,
      access_patterns: ["cron_import_worker", "service_role_only"],
      notes: "Ingest/worker tables; block anon/authenticated direct access.",
    };
  }
  if (CLAIMS_TABLES.has(table)) {
    return {
      classification: policyCount > 0 ? "A" : "B",
      phase: 3,
      high_risk: false,
      access_patterns: ["authenticated_user", "service_role_only"],
      notes: "Claims domain; org-scoped SELECT, service_role for workers.",
    };
  }
  if (SCANNER_TABLES.has(table)) {
    return {
      classification: "B",
      phase: 2,
      high_risk: false,
      access_patterns: ["scanner_operator", "service_role_only"],
      notes: "Scanner operational; needs store assignment helper.",
    };
  }
  if (PHASE1_SAFE.has(table)) {
    return {
      classification: rls && policyCount > 0 ? "A" : "A",
      phase: 1,
      high_risk: false,
      access_patterns: ["authenticated_user", "service_role_only"],
      notes: "Straightforward org-scoped policies.",
    };
  }
  if (table.startsWith("amazon_")) {
    return {
      classification: "C",
      phase: 0,
      high_risk: false,
      access_patterns: ["cron_import_worker", "service_role_only"],
      notes: "Amazon domain import table.",
    };
  }
  if (table.startsWith("pim_")) {
    return {
      classification: rls && policyCount > 0 ? "A" : "B",
      phase: 1,
      high_risk: false,
      access_patterns: ["authenticated_user", "service_role_only"],
      notes: "PIM auxiliary.",
    };
  }
  if (table.startsWith("v_") || table.startsWith("mv_")) {
    return {
      classification: "D",
      phase: 0,
      high_risk: false,
      access_patterns: ["authenticated_user", "scanner_operator"],
      notes: "View — secure underlying tables; view grants only.",
    };
  }
  if (!hasOrg && !hasStore) {
    return {
      classification: "F",
      phase: 0,
      high_risk: false,
      access_patterns: ["internal_rpc_only"],
      notes: "No org/store column — needs policy design or service-role-only.",
    };
  }
  if (hasOrg && !rls) {
    return {
      classification: "A",
      phase: 1,
      high_risk: false,
      access_patterns: ["authenticated_user", "service_role_only"],
      notes: "Has organization_id; enable RLS + org member policies.",
    };
  }
  if (hasOrg && rls && policyCount === 0) {
    return {
      classification: "B",
      phase: 1,
      high_risk: false,
      access_patterns: ["authenticated_user", "service_role_only"],
      notes: "RLS enabled but zero policies — default deny blocks all non-service-role.",
    };
  }
  return {
    classification: "B",
    phase: 1,
    high_risk: false,
    access_patterns: ["authenticated_user", "service_role_only"],
    notes: "",
  };
}

function orgPolicySql(table: string, ops: ("SELECT" | "INSERT" | "UPDATE" | "DELETE")[] = ["SELECT", "INSERT", "UPDATE", "DELETE"]): string {
  const lines: string[] = [];
  for (const op of ops) {
    const suffix = op.toLowerCase();
    lines.push(`
CREATE POLICY IF NOT EXISTS "${table}_org_${suffix}"
  ON public.${table} FOR ${op}
  USING (organization_id = public.get_my_organization_id())
  WITH CHECK (organization_id = public.get_my_organization_id());`.trim());
  }
  lines.push(`
CREATE POLICY IF NOT EXISTS "${table}_service_role_bypass"
  ON public.${table} AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);`.trim());
  return lines.join("\n\n");
}

function storeScopedPolicySql(table: string): string {
  return `
-- Requires: public.user_can_access_store(store_id uuid) helper (Phase 2)
ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "${table}_org_store_select"
  ON public.${table} FOR SELECT
  USING (
    organization_id = public.get_my_organization_id()
    AND (
      store_id IS NULL
      OR public.user_can_access_store(store_id)
    )
  );

CREATE POLICY IF NOT EXISTS "${table}_org_store_write"
  ON public.${table} FOR ALL
  USING (
    organization_id = public.get_my_organization_id()
    AND (store_id IS NULL OR public.user_can_access_store(store_id))
  )
  WITH CHECK (
    organization_id = public.get_my_organization_id()
    AND (store_id IS NULL OR public.user_can_access_store(store_id))
  );

CREATE POLICY IF NOT EXISTS "${table}_service_role_bypass"
  ON public.${table} AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);
`.trim();
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const ref = refFromSupabaseUrl(process.env.ORIGINAL_SUPABASE_URL ?? dbUrl);
  if (!dbUrl || ref !== ORIGINAL_REF) {
    throw new Error(`ORIGINAL_DIRECT_POSTGRES_URL must target ${ORIGINAL_REF}, got ${ref ?? "missing"}`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const tablesRes = await client.query(`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           COALESCE(s.n_live_tup, 0)::bigint AS row_estimate
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    ORDER BY c.relname
  `);

  const policiesRes = await client.query(`
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname
  `);

  const colsRes = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN ('organization_id', 'store_id', 'user_id', 'profile_id', 'created_by', 'owner_id')
  `);

  const storageRes = await client.query(`
    SELECT schemaname, tablename, policyname, roles, cmd
    FROM pg_policies
    WHERE schemaname = 'storage'
    ORDER BY tablename, policyname
  `);

  const bucketsRes = await client.query(`
    SELECT id, name, public, file_size_limit, allowed_mime_types
    FROM storage.buckets
    ORDER BY name
  `);

  const rpcRes = await client.query(`
    SELECT p.proname AS name,
           pg_get_function_identity_arguments(p.oid) AS args,
           p.prosecdef AS security_definer
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
    ORDER BY p.proname
  `);

  await client.end();

  const policiesByTable = new Map<string, string[]>();
  for (const row of policiesRes.rows as { tablename: string; policyname: string; cmd: string; roles: string }[]) {
    const list = policiesByTable.get(row.tablename) ?? [];
    list.push(`${row.policyname} (${row.cmd}; roles=${JSON.stringify(row.roles)})`);
    policiesByTable.set(row.tablename, list);
  }

  const colsByTable = new Map<string, Set<string>>();
  for (const row of colsRes.rows as { table_name: string; column_name: string }[]) {
    const set = colsByTable.get(row.table_name) ?? new Set();
    set.add(row.column_name);
    colsByTable.set(row.table_name, set);
  }

  const audits: TableAudit[] = [];
  for (const row of tablesRes.rows as {
    table_name: string;
    rls_enabled: boolean;
    row_estimate: string;
  }[]) {
    const table = row.table_name;
    const cols = colsByTable.get(table) ?? new Set();
    const hasOrg = cols.has("organization_id");
    const hasStore = cols.has("store_id");
    const hasUserOwner = cols.has("user_id") || cols.has("profile_id") || cols.has("created_by") || cols.has("owner_id");
    const policies = policiesByTable.get(table) ?? [];
    const manual = classifyTable(table, row.rls_enabled, policies.length, hasOrg, hasStore);
    audits.push({
      table,
      rls_enabled: row.rls_enabled,
      policy_count: policies.length,
      policies,
      row_estimate: Number(row.row_estimate) || null,
      has_organization_id: hasOrg,
      has_store_id: hasStore,
      has_user_owner: hasUserOwner,
      high_risk: manual.high_risk ?? SENSITIVE_TABLES.has(table),
      access_patterns: manual.access_patterns ?? ["service_role_only"],
      app_surfaces: scanCodebaseForTable(table),
      classification: manual.classification,
      phase: manual.phase as TableAudit["phase"],
      notes: manual.notes,
    });
  }

  const rlsEnabled = audits.filter((a) => a.rls_enabled).length;
  const rlsMissing = audits.filter((a) => !a.rls_enabled).length;
  const phase1 = audits.filter((a) => a.phase === 1 && !isBackupTable(a.table));
  const phase2 = audits.filter((a) => a.phase === 2);
  const sensitive = audits.filter((a) => a.high_risk || a.classification === "E");
  const blockers = [
    "Do not enable RLS on scanner tables until user_can_access_store() helper exists and scanner smokes pass on staging.",
    "Import/cron paths must retain service_role bypass policies on ingest tables (amazon_*, raw_report_uploads, FRR).",
    "marketplaces / organization_api_keys: audit column exposure before any authenticated SELECT policy.",
    "workspace_settings current authenticated-ALL policy is too permissive — code gate before RLS tighten.",
    "Views (v_*) inherit underlying table RLS — phase table RLS before exposing views to anon.",
    "Verify all Next.js server actions use createServerClient with user session OR createServiceRoleClient for imports.",
  ];

  const invMd = [
    "# 01 — Table RLS inventory (original/live)",
    "",
    `**Target ref:** \`${ORIGINAL_REF}\`  `,
    `**Run:** \`${runId}\`  `,
    `**Mode:** read-only audit — **RLS not enabled by this pack**`,
    "",
    "| Table | RLS | Policies | Rows~ | org_id | store_id | High risk | Class | Phase | Access | Surfaces |",
    "|-------|-----|----------|------:|:------:|:--------:|:---------:|:-----:|------:|--------|----------|",
    ...audits.map(
      (a) =>
        `| \`${a.table}\` | ${a.rls_enabled ? "yes" : "**no**"} | ${a.policy_count} | ${a.row_estimate ?? "—"} | ${a.has_organization_id ? "Y" : "—"} | ${a.has_store_id ? "Y" : "—"} | ${a.high_risk ? "**yes**" : "no"} | ${a.classification} | ${a.phase} | ${a.access_patterns.join(", ")} | ${a.app_surfaces.slice(0, 2).join("; ") || "—"} |`,
    ),
    "",
    `**Totals:** ${audits.length} tables | RLS enabled: ${rlsEnabled} | RLS missing: ${rlsMissing}`,
  ].join("\n");

  const gapMd = [
    "# 02 — Policy gap matrix",
    "",
    "## Classification key",
    "",
    "| Class | Meaning |",
    "|-------|---------|",
    "| A | Enable RLS now — straightforward org policies |",
    "| B | Needs org/store policy helper first |",
    "| C | Service-role / import worker only |",
    "| D | Public read safe (authenticated, no anon) |",
    "| E | Do not expose to anon; lock credentials |",
    "| F | Needs code change before RLS |",
    "",
    "## Gaps by class",
    "",
    ...(["A", "B", "C", "D", "E", "F"] as ClassLetter[]).map((cls) => {
      const rows = audits.filter((a) => a.classification === cls);
      return `### ${cls} (${rows.length})\n\n${rows.map((r) => `- \`${r.table}\` — RLS ${r.rls_enabled ? "on" : "off"}, ${r.policy_count} policies. ${r.notes}`).join("\n") || "_none_"}`;
    }),
    "",
    "## Critical must-cover tables",
    "",
    ...[
      "products",
      "product_identifier_map",
      "product_prices",
      "vendors",
      "product_categories",
      "packages",
      "pallets",
      "return_items",
      "expected_packages",
      "amazon_removals",
      "amazon_removal_shipments",
      "raw_report_uploads",
      "claim_candidates",
      "claim_candidate_drafts",
      "claim_lines",
      "organization_api_keys",
      "marketplaces",
      "audit_events",
      "undo_snapshots",
    ].map((t) => {
      const a = audits.find((x) => x.table === t);
      if (!a) return `- \`${t}\` — **not present on original**`;
      const gap =
        !a.rls_enabled ? "RLS disabled" : a.policy_count === 0 ? "RLS on, zero policies" : "policies present — review scope";
      return `- \`${t}\` — ${gap}; class **${a.classification}**; phase **${a.phase}**`;
    }),
  ].join("\n");

  const phase1Sql = [
    "-- 03_phase1_safe_rls.sql",
    "-- DO NOT APPLY WITHOUT OPERATOR APPROVAL",
    "-- Phase 1: low-risk org-scoped tables + permissions catalog",
    "-- Service role bypass preserved on all tables.",
    "",
    "-- Prerequisite helpers (idempotent)",
    "CREATE OR REPLACE FUNCTION public.get_my_organization_id()",
    "RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$",
    "  SELECT organization_id FROM public.profiles WHERE id = auth.uid() LIMIT 1;",
    "$$;",
    "",
    ...phase1
      .filter((a) => !a.rls_enabled || a.policy_count === 0)
      .map((a) => `-- ${a.table}\nALTER TABLE public.${a.table} ENABLE ROW LEVEL SECURITY;\n${orgPolicySql(a.table)}`),
  ].join("\n\n");

  const phase2Sql = [
    "-- 04_phase2_scanner_rls.sql",
    "-- DO NOT APPLY WITHOUT OPERATOR APPROVAL + SCANNER SMOKE PASS",
    "",
    `-- Store access helper (from user_store_assignments + tenant admin override)`,
    `CREATE OR REPLACE FUNCTION public.user_can_access_store(p_store_id uuid)`,
    `RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$`,
    `  SELECT EXISTS (`,
    `    SELECT 1 FROM public.user_store_assignments usa`,
    `    WHERE usa.profile_id = auth.uid()`,
    `      AND usa.store_id = p_store_id`,
    `      AND usa.organization_id = public.get_my_organization_id()`,
    `  ) OR EXISTS (`,
    `    SELECT 1 FROM public.profiles p`,
    `    WHERE p.id = auth.uid()`,
    `      AND p.organization_id = public.get_my_organization_id()`,
    `      AND p.role IN ('admin', 'tenant_admin', 'platform_admin', 'super_admin')`,
    `  );`,
    `$$;`,
    "",
    ...phase2.map((a) => storeScopedPolicySql(a.table)),
  ].join("\n\n");

  const phase3Sql = [
    "-- 05_phase3_claims_rls.sql",
    "-- DO NOT APPLY WITHOUT OPERATOR APPROVAL",
    "",
    ...audits
      .filter((a) => a.phase === 3)
      .map(
        (a) =>
          `-- ${a.table}\nALTER TABLE public.${a.table} ENABLE ROW LEVEL SECURITY;\n${orgPolicySql(a.table, ["SELECT", "INSERT", "UPDATE"])}`,
      ),
  ].join("\n\n");

  const phase4Sql = [
    "-- 06_phase4_sensitive_credentials_lockdown.sql",
    "-- DO NOT APPLY WITHOUT OPERATOR APPROVAL",
    "-- Revoke direct authenticated SELECT on secret columns; server actions only.",
    "",
    ...sensitive.map((a) => {
      if (a.table === "organization_api_keys") {
        return `-- organization_api_keys: service_role + admin RPC only\nREVOKE ALL ON public.organization_api_keys FROM anon, authenticated;\nGRANT SELECT (id, organization_id, label, created_at, last_used_at) ON public.organization_api_keys TO authenticated;\n-- secret columns via SECURITY DEFINER get_org_api_key_metadata() only`;
      }
      if (a.table === "marketplaces") {
        return `-- marketplaces: hide credential JSON from authenticated direct select\n-- Use column privileges or redacted view v_marketplaces_safe\nCREATE OR REPLACE VIEW public.v_marketplaces_safe AS\n  SELECT id, organization_id, name, marketplace_type, role_required, created_at, updated_at\n  FROM public.marketplaces;\nGRANT SELECT ON public.v_marketplaces_safe TO authenticated;`;
      }
      return `-- ${a.table}: service_role bypass only\nALTER TABLE public.${a.table} ENABLE ROW LEVEL SECURITY;\nCREATE POLICY IF NOT EXISTS "${a.table}_service_role_only" ON public.${a.table} FOR ALL TO service_role USING (true) WITH CHECK (true);`;
    }),
  ].join("\n\n");

  const storageSql = [
    "-- 07_storage_rls.sql",
    "-- DO NOT APPLY WITHOUT OPERATOR APPROVAL",
    "",
    "-- Current buckets:",
    ...(bucketsRes.rows as { name: string; public: boolean }[]).map(
      (b) => `-- bucket: ${b.name} public=${b.public}`,
    ),
    "",
    "-- Existing storage policies:",
    ...(storageRes.rows as { tablename: string; policyname: string; cmd: string; roles: string }[]).map(
      (p) => `-- ${p.tablename}.${p.policyname} (${p.cmd}) roles=${p.roles}`,
    ),
    "",
    `-- Recommended: org-scoped path prefix {org_id}/ on raw-reports, claim-evidence, product-images`,
    `CREATE POLICY IF NOT EXISTS "raw_reports_org_read" ON storage.objects FOR SELECT TO authenticated`,
    `  USING (bucket_id = 'raw-reports' AND (storage.foldername(name))[1] = public.get_my_organization_id()::text);`,
    "",
    `CREATE POLICY IF NOT EXISTS "raw_reports_org_insert" ON storage.objects FOR INSERT TO authenticated`,
    `  WITH CHECK (bucket_id = 'raw-reports' AND (storage.foldername(name))[1] = public.get_my_organization_id()::text);`,
  ].join("\n");

  const testSql = [
    "-- 08_rls_test_queries.sql",
    "-- Run as authenticated test user and service_role in staging before production.",
    "",
    "SET ROLE authenticated;",
    "SELECT count(*) FROM public.products WHERE organization_id = public.get_my_organization_id();",
    "SELECT count(*) FROM public.expected_packages WHERE organization_id = public.get_my_organization_id();",
    "SELECT count(*) FROM public.return_items WHERE organization_id = public.get_my_organization_id();",
    "-- Must fail or return 0 for other org:",
    "SELECT count(*) FROM public.products WHERE organization_id <> public.get_my_organization_id();",
    "",
    "RESET ROLE;",
    "-- Service role smoke (imports):",
    "-- use service_role JWT; verify rebuild_expected_packages_from_removals succeeds",
  ].join("\n");

  const rollbackSql = [
    "-- 09_rollback.sql",
    "-- Emergency: disable RLS on a table (LAST RESORT — exposes data)",
    "",
    ...phase2.map((a) => `-- ALTER TABLE public.${a.table} DISABLE ROW LEVEL SECURITY;`),
    "",
    "-- Prefer: drop new policies only",
    ...phase2.map((a) => `-- DROP POLICY IF EXISTS "${a.table}_org_store_select" ON public.${a.table};`),
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "01_table_rls_inventory.md"), invMd + "\n");
  fs.writeFileSync(path.join(outDir, "02_policy_gap_matrix.md"), gapMd + "\n");
  fs.writeFileSync(path.join(outDir, "03_phase1_safe_rls.sql"), phase1Sql + "\n");
  fs.writeFileSync(path.join(outDir, "04_phase2_scanner_rls.sql"), phase2Sql + "\n");
  fs.writeFileSync(path.join(outDir, "05_phase3_claims_rls.sql"), phase3Sql + "\n");
  fs.writeFileSync(path.join(outDir, "06_phase4_sensitive_credentials_lockdown.sql"), phase4Sql + "\n");
  fs.writeFileSync(path.join(outDir, "07_storage_rls.sql"), storageSql + "\n");
  fs.writeFileSync(path.join(outDir, "08_rls_test_queries.sql"), testSql + "\n");
  fs.writeFileSync(path.join(outDir, "09_rollback.sql"), rollbackSql + "\n");

  const phase1Gaps = phase1.filter((a) => !a.rls_enabled || a.policy_count === 0);
  const criticalMissingRls = [
    "claim_candidates",
    "claim_cases",
    "groups",
    "roles",
    "claim_reimbursements",
  ].filter((t) => {
    const a = audits.find((x) => x.table === t);
    return a && (!a.rls_enabled || a.policy_count === 0);
  });
  const rlsOnZeroPolicy = audits.filter((a) => a.rls_enabled && a.policy_count === 0 && !isBackupTable(a.table));
  const safePhase1 =
    criticalMissingRls.length === 0 &&
    rlsOnZeroPolicy.every((a) => ["product_prices", "vendors", "product_categories"].includes(a.table));

  const summary = {
    prompt: "PRODUCTION_RLS_HARDENING_AUDIT_AND_PHASED_PLAN",
    run_id: runId,
    target_ref: ORIGINAL_REF,
    tables_total: audits.length,
    rls_enabled_count: rlsEnabled,
    rls_missing_count: rlsMissing,
    phase1_tables: phase1.map((a) => a.table),
    phase2_tables: phase2.map((a) => a.table),
    sensitive_tables: sensitive.map((a) => a.table),
    blockers_before_enable: blockers,
    SAFE_TO_APPLY_PHASE1: safePhase1 ? "yes" : "no",
    phase1_gap_tables: phase1Gaps.map((a) => a.table),
    rls_on_zero_policy_tables: rlsOnZeroPolicy.map((a) => a.table),
    critical_missing_rls: criticalMissingRls,
    do_not_apply_yet: [
      "04_phase2_scanner_rls.sql",
      "06_phase4_sensitive_credentials_lockdown.sql",
      "07_storage_rls.sql",
      "03_phase1_safe_rls.sql — staging proof required first",
    ],
    storage_buckets: (bucketsRes.rows as { name: string; public: boolean }[]).length,
    storage_policies: storageRes.rows.length,
    rpc_count: rpcRes.rows.length,
    no_db_writes: true,
  };

  const implSummary = [
    "# Production RLS hardening — implementation summary",
    "",
    `**Target:** \`${ORIGINAL_REF}\` (Vercel Production DB)  `,
    `**Run:** \`${runId}\`  `,
    "**RLS enabled by this audit:** NO (plan only)",
    "",
    "## Headline counts",
    "",
    `| Metric | Value |`,
    `|--------|------:|`,
    `| Tables (public) | ${audits.length} |`,
    `| RLS enabled | ${rlsEnabled} |`,
    `| RLS missing | ${rlsMissing} |`,
    `| Phase 1 candidates | ${phase1.length} |`,
    `| Phase 2 scanner | ${phase2.length} |`,
    `| Sensitive | ${sensitive.length} |`,
    "",
    "## Critical production gaps",
    "",
    ...[
      "products",
      "product_identifier_map",
      "expected_packages",
      "return_items",
      "claim_candidates",
      "organization_api_keys",
      "marketplaces",
    ].map((t) => {
      const a = audits.find((x) => x.table === t);
      if (!a) return `- \`${t}\` — not on original`;
      return `- \`${t}\` — RLS ${a.rls_enabled ? "ON" : "OFF"}, ${a.policy_count} policies, class **${a.classification}**, phase **${a.phase}**`;
    }),
    "",
    "## Rollout order",
    "",
    "1. **Phase 1** — permissions, profiles, stores, user_store_assignments, PIM aux, fix RLS-on/zero-policy (vendors, product_prices, product_categories)",
    "2. **Phase 2** — scanner spine (after `user_can_access_store()` + staging scanner smoke)",
    "3. **Phase 3** — claims tables missing policies (`claim_candidates`, `claim_cases`)",
    "4. **Phase 4** — credentials lockdown (marketplaces, organization_api_keys)",
    "5. **Storage** — org-prefixed bucket paths",
    "",
    `**SAFE_TO_APPLY_PHASE1:** ${safePhase1 ? "yes" : "no"}`,
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "implementation-summary.md"), implSummary + "\n");
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(summary, null, 2));

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
