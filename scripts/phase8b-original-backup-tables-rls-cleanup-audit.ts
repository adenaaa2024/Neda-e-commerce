/**
 * PHASE-8B-ORIGINAL-BACKUP-TABLES-RLS-AND-CLEANUP-AUDIT (read-only)
 * Target: original/live kxsvedvpjldygtdbylsy
 *
 *   npx tsx scripts/phase8b-original-backup-tables-rls-cleanup-audit.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/phase8b-original-backup-tables-rls-cleanup-audit";

const INVENTORY_VIEWS = [
  "v_inventory_status",
  "v_inventory_item_status",
  "v_scanned_items_counted",
] as const;

const CLAIM_VIEW_PREFIX = "v_claim_";
const FINANCE_VIEW_PREFIXES = ["v_finance_", "v_settlement_", "v_reimbursement_", "v_amazon_financial"];

type BackupTableReport = {
  table_name: string;
  row_count: number | null;
  size_bytes: number | null;
  size_pretty: string | null;
  migration_source: string;
  referenced_by_db: boolean;
  db_references: string[];
  referenced_by_app: boolean;
  app_references: string[];
  contains_sensitive_data: boolean;
  sensitive_reason: string;
  rls_enabled: boolean;
  public_permissions: Record<string, string[]>;
  safe_to_keep: boolean;
  safe_to_archive_schema: boolean;
  safe_to_drop: boolean;
  notes: string;
};

type ViewReport = {
  view_name: string;
  category: "inventory" | "claim" | "finance";
  security_invoker: boolean | null;
  security_definer: boolean;
  underlying_tables: string[];
  underlying_rls: Record<string, boolean>;
  grants: Record<string, string[]>;
  data_leak_risk: "none" | "low" | "medium" | "high" | "critical";
  recommended_fix: string;
  referenced_by_app: boolean;
  app_references: string[];
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

function scanCodebase(name: string): string[] {
  const surfaces: string[] = [];
  const dirs = ["app", "lib", "components", "scripts", "supabase"];
  for (const dir of dirs) {
    const abs = path.join(process.cwd(), dir);
    if (!fs.existsSync(abs)) continue;
    try {
      const out = execSync(`rg -l --glob "*.{ts,tsx,sql,py}" "${name}" "${abs}"`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      if (out) {
        for (const f of out.split("\n").slice(0, 10)) {
          surfaces.push(path.relative(process.cwd(), f).replace(/\\/g, "/"));
        }
      }
    } catch {
      /* no matches */
    }
  }
  return [...new Set(surfaces)].slice(0, 10);
}

function scanMigrationSource(table: string): string {
  const hits: string[] = [];
  try {
    const out = execSync(`rg -l "${table}" scripts supabase --glob "*.{ts,sql}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (out) hits.push(...out.split("\n").slice(0, 5).map((f) => path.basename(f)));
  } catch {
    /* none */
  }
  if (table.startsWith("_backup_phase_ab_")) return hits.length ? hits.join("; ") : "original-product-pim-parity-phase-a-b-execute";
  if (table.startsWith("_backup_scoped_pim_")) return hits.length ? hits.join("; ") : "apply-original-scoped-product-pim-parity";
  if (table.startsWith("_backup_demo_replace_")) return hits.length ? hits.join("; ") : "original-demo-data-parity-apply";
  if (table.startsWith("_audit_original_demo_schema_parity_")) return hits.length ? hits.join("; ") : "original-demo-schema-parity-apply";
  return hits.length ? hits.join("; ") : "unknown — operator DDL snapshot";
}

function inferSensitive(table: string, columns: string[]): { yes: boolean; reason: string } {
  const sensitiveCols = [
    "credentials",
    "api_key",
    "secret",
    "password",
    "token",
    "ssn",
    "email",
    "phone",
    "address",
    "asin",
    "sku",
    "fnsku",
    "upc",
    "title",
    "product_name",
    "metadata",
  ];
  const hit = columns.filter((c) => sensitiveCols.some((s) => c.includes(s)));
  const isPimBackup =
    table.includes("products") || table.includes("map") || table.includes("product");
  if (hit.length > 0 || isPimBackup) {
    return {
      yes: true,
      reason: isPimBackup
        ? `PIM/catalog backup (${hit.join(", ") || "product identifiers"})`
        : `columns: ${hit.join(", ")}`,
    };
  }
  return { yes: false, reason: "empty or structural snapshot only" };
}

async function tableGrants(client: pg.Client, table: string): Promise<Record<string, string[]>> {
  const res = await client.query(
    `SELECT grantee, privilege_type
     FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = $1
       AND grantee IN ('anon', 'authenticated', 'service_role', 'public', 'postgres')
     ORDER BY grantee, privilege_type`,
    [table],
  );
  const out: Record<string, string[]> = {};
  for (const row of res.rows as { grantee: string; privilege_type: string }[]) {
    out[row.grantee] ??= [];
    out[row.grantee].push(row.privilege_type);
  }
  return out;
}

async function dbReferences(client: pg.Client, table: string): Promise<string[]> {
  const refs: string[] = [];
  const views = await client.query(
    `SELECT DISTINCT v.viewname
     FROM pg_views v
     JOIN pg_depend d ON d.refobjid = (quote_ident('public') || '.' || quote_ident($1))::regclass
     JOIN pg_rewrite r ON r.oid = d.objid
     JOIN pg_class c ON c.oid = r.ev_class
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v'`,
    [table],
  ).catch(() => ({ rows: [] }));

  const deps = await client.query(
    `SELECT DISTINCT
       CASE c.relkind
         WHEN 'v' THEN 'view:' || c.relname
         WHEN 'r' THEN 'table:' || c.relname
         WHEN 'm' THEN 'matview:' || c.relname
         ELSE c.relkind::text || ':' || c.relname
       END AS ref
     FROM pg_depend d
     JOIN pg_class c ON c.oid = d.objid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE d.refobjid = (quote_ident('public') || '.' || quote_ident($1))::regclass
       AND d.deptype = 'n'
       AND n.nspname = 'public'
       AND c.relname != $1`,
    [table],
  );

  const triggers = await client.query(
    `SELECT tgname FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = $1 AND NOT t.tgisinternal`,
    [table],
  ).catch(() => ({ rows: [] }));

  const funcs = await client.query(
    `SELECT DISTINCT p.proname
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_functiondef(p.oid) ILIKE '%' || $1 || '%'`,
    [table],
  ).catch(() => ({ rows: [] }));

  for (const r of views.rows as { viewname: string }[]) refs.push(`view:${r.viewname}`);
  for (const r of deps.rows as { ref: string }[]) refs.push(r.ref);
  for (const r of triggers.rows as { tgname: string }[]) refs.push(`trigger:${r.tgname}`);
  for (const r of funcs.rows as { proname: string }[]) refs.push(`function:${r.proname}`);
  return [...new Set(refs)];
}

async function underlyingTables(client: pg.Client, viewName: string): Promise<string[]> {
  const res = await client.query(
    `WITH RECURSIVE deps AS (
       SELECT DISTINCT c2.relname AS tbl, c2.relkind
       FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       JOIN pg_class c ON c.oid = r.ev_class
       JOIN pg_depend d2 ON d2.objid = c.oid
       JOIN pg_class c2 ON c2.oid = d2.refobjid
       JOIN pg_namespace n ON n.oid = c2.relnamespace
       WHERE c.relname = $1 AND n.nspname = 'public' AND c2.relkind IN ('r','v','m')
       UNION
       SELECT c2.relname, c2.relkind
       FROM deps d
       JOIN pg_class c ON c.relname = d.tbl
       JOIN pg_depend d2 ON d2.objid = c.oid
       JOIN pg_class c2 ON c2.oid = d2.refobjid
       JOIN pg_namespace n ON n.oid = c2.relnamespace
       WHERE n.nspname = 'public' AND c2.relkind IN ('r','v','m') AND c2.relname != d.tbl
     )
     SELECT DISTINCT tbl FROM deps WHERE tbl != $1 ORDER BY tbl`,
    [viewName],
  ).catch(async () => {
    const def = await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [
      `public.${viewName}`,
    ]);
    const text = (def.rows[0] as { def: string })?.def ?? "";
    const tables = [...text.matchAll(/\b(?:FROM|JOIN)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)].map(
      (m) => m[1]!.toLowerCase(),
    );
    return { rows: [...new Set(tables)].map((tbl) => ({ tbl })) };
  });
  return (res.rows as { tbl: string }[]).map((r) => r.tbl);
}

function viewCategory(name: string): ViewReport["category"] {
  if (INVENTORY_VIEWS.includes(name as (typeof INVENTORY_VIEWS)[number])) return "inventory";
  if (name.startsWith(CLAIM_VIEW_PREFIX)) return "claim";
  return "finance";
}

function assessViewRisk(
  view: string,
  securityInvoker: boolean | null,
  underlyingRls: Record<string, boolean>,
  grants: Record<string, string[]>,
  hasOrgColumn: boolean,
): { risk: ViewReport["data_leak_risk"]; fix: string } {
  const anonSelect = grants.anon?.includes("SELECT");
  const authSelect = grants.authenticated?.includes("SELECT");
  const exposed = anonSelect || authSelect;
  const allUnderlyingRls = Object.values(underlyingRls);
  const anyNoRls = allUnderlyingRls.some((v) => !v);
  const allRls = allUnderlyingRls.length > 0 && allUnderlyingRls.every(Boolean);

  if (!exposed) {
    return { risk: "none", fix: "No anon/authenticated SELECT — service_role only; OK if intentional." };
  }
  if (securityInvoker === true && allRls) {
    return {
      risk: hasOrgColumn ? "low" : "medium",
      fix: hasOrgColumn
        ? "security_invoker + underlying RLS — verify org/store policies on all base tables."
        : "security_invoker + RLS but view lacks org filter column — add org_id to projection or restrict grants.",
    };
  }
  if (securityInvoker === false || securityInvoker === null) {
    if (anyNoRls) {
      return {
        risk: "critical",
        fix: "View runs as definer (default PG<15 or not set) with RLS-off base table(s) — recreate WITH (security_invoker=true) and enable RLS on bases, or REVOKE anon/authenticated SELECT.",
      };
    }
    return {
      risk: "high",
      fix: "Default security definer view over RLS tables — authenticated may bypass tenant isolation. Set security_invoker=true and verify policies.",
    };
  }
  return { risk: "medium", fix: "Review grants and underlying RLS alignment." };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (refFromSupabaseUrl(dbUrl) !== ORIGINAL_REF && !dbUrl.includes(ORIGINAL_REF)) {
    throw new Error("ORIGINAL_DIRECT_POSTGRES_URL must target original ref");
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const backupTablesRes = await client.query(
    `SELECT c.relname AS table_name,
            c.reltuples::bigint AS row_estimate,
            pg_total_relation_size(c.oid) AS size_bytes,
            pg_size_pretty(pg_total_relation_size(c.oid)) AS size_pretty,
            c.relrowsecurity AS rls_enabled
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND (c.relname LIKE '\\_backup\\_%' ESCAPE '\\'
            OR c.relname LIKE '\\_audit\\_original\\_demo\\_schema\\_parity\\_%' ESCAPE '\\')
     ORDER BY c.relname`,
  );

  const backupTablesReport: BackupTableReport[] = [];
  for (const row of backupTablesRes.rows as {
    table_name: string;
    row_estimate: number;
    size_bytes: number;
    size_pretty: string;
    rls_enabled: boolean;
  }[]) {
    const table = row.table_name;
    let rowCount: number | null = null;
    try {
      const cnt = await client.query(`SELECT count(*)::bigint AS c FROM public.${table}`);
      rowCount = Number((cnt.rows[0] as { c: string }).c);
    } catch {
      rowCount = row.row_estimate >= 0 ? Math.round(row.row_estimate) : null;
    }

    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
      [table],
    );
    const colNames = (cols.rows as { column_name: string }[]).map((r) => r.column_name);
    const sensitive = inferSensitive(table, colNames);
    const grants = await tableGrants(client, table);
    const dbRefs = await dbReferences(client, table);
    const appRefs = scanCodebase(table);
    const migrationSource = scanMigrationSource(table);

    const referencedByDb = dbRefs.length > 0;
    const referencedByApp = appRefs.some((f) => !f.includes("phase8b-original-backup") && !f.includes("probe-backup"));
    const hasPublicSelect =
      grants.public?.includes("SELECT") ||
      grants.anon?.includes("SELECT") ||
      grants.authenticated?.includes("SELECT");

    const safeToKeep = referencedByDb || referencedByApp;
    const safeToArchive =
      !referencedByDb &&
      !referencedByApp &&
      !hasPublicSelect &&
      (rowCount ?? 0) >= 0;
    const safeToDrop =
      !referencedByDb &&
      !referencedByApp &&
      !hasPublicSelect &&
      (rowCount === 0 || table.includes("_empty_") || table.endsWith("_as_select_1_where_false"));

    backupTablesReport.push({
      table_name: table,
      row_count: rowCount,
      size_bytes: Number(row.size_bytes),
      size_pretty: row.size_pretty,
      migration_source: migrationSource,
      referenced_by_db: referencedByDb,
      db_references: dbRefs,
      referenced_by_app: referencedByApp,
      app_references: appRefs.filter((f) => !f.includes("phase8b-original-backup")),
      contains_sensitive_data: sensitive.yes,
      sensitive_reason: sensitive.reason,
      rls_enabled: row.rls_enabled,
      public_permissions: grants,
      safe_to_keep: safeToKeep,
      safe_to_archive_schema: safeToArchive && !safeToKeep,
      safe_to_drop: safeToDrop && !safeToKeep && !sensitive.yes,
      notes: hasPublicSelect
        ? "Has anon/authenticated/public SELECT — revoke before any drop."
        : referencedByDb
          ? "DB dependency exists — do not drop without dependency audit."
          : "Operator snapshot — retention per parity runbook.",
    });
  }

  const allViewsRes = await client.query(
    `SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY viewname`,
  );
  const allViewNames = (allViewsRes.rows as { viewname: string }[]).map((r) => r.viewname);
  const targetViews = allViewNames.filter(
    (v) =>
      INVENTORY_VIEWS.includes(v as (typeof INVENTORY_VIEWS)[number]) ||
      v.startsWith(CLAIM_VIEW_PREFIX) ||
      FINANCE_VIEW_PREFIXES.some((p) => v.startsWith(p)),
  );

  const viewsReport: ViewReport[] = [];
  for (const viewName of targetViews) {
    const opts = await client.query(
      `SELECT reloptions FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind = 'v'`,
      [viewName],
    );
    const reloptions = (opts.rows[0] as { reloptions: string[] | null })?.reloptions ?? [];
    const optStr = reloptions.join(",");
    const securityInvoker = optStr.includes("security_invoker=true")
      ? true
      : optStr.includes("security_invoker=false")
        ? false
        : null;
    const securityDefiner = securityInvoker !== true;

    const underlying = await underlyingTables(client, viewName);
    const underlyingRls: Record<string, boolean> = {};
    for (const t of underlying) {
      if (t.startsWith("v_") || t.startsWith("mv_")) continue;
      const r = await client.query(
        `SELECT relrowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname='public' AND c.relname=$1`,
        [t],
      );
      underlyingRls[t] = (r.rows[0] as { relrowsecurity: boolean } | undefined)?.relrowsecurity ?? false;
    }

    const grants = await tableGrants(client, viewName);
    const colCheck = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1
         AND column_name IN ('organization_id','store_id')`,
      [viewName],
    );
    const hasOrgColumn = colCheck.rows.length > 0;
    const { risk, fix } = assessViewRisk(viewName, securityInvoker, underlyingRls, grants, hasOrgColumn);
    const appRefs = scanCodebase(viewName);

    viewsReport.push({
      view_name: viewName,
      category: viewCategory(viewName),
      security_invoker: securityInvoker,
      security_definer: securityDefiner,
      underlying_tables: underlying,
      underlying_rls: underlyingRls,
      grants,
      data_leak_risk: risk,
      recommended_fix: fix,
      referenced_by_app: appRefs.length > 0,
      app_references: appRefs.slice(0, 8),
    });
  }

  await client.end();

  const highRiskObjects = [
    ...backupTablesReport
      .filter((t) => !t.rls_enabled && (t.public_permissions.anon?.includes("SELECT") || t.public_permissions.authenticated?.includes("SELECT")))
      .map((t) => ({ kind: "backup_table", name: t.table_name, risk: "RLS off + public SELECT" })),
    ...backupTablesReport
      .filter((t) => t.contains_sensitive_data && (t.public_permissions.anon?.includes("SELECT") || t.public_permissions.authenticated?.includes("SELECT")))
      .map((t) => ({ kind: "backup_table", name: t.table_name, risk: "sensitive backup exposed via grants" })),
    ...viewsReport
      .filter((v) => v.data_leak_risk === "critical" || v.data_leak_risk === "high")
      .map((v) => ({ kind: "view", name: v.view_name, risk: v.data_leak_risk })),
  ];

  const safeCleanupPlan = [
    "Phase 8B-1 (approval): REVOKE SELECT on all _backup_* / _audit_* tables from anon, authenticated, public — service_role only.",
    "Phase 8B-2 (approval): ENABLE ROW LEVEL SECURITY on backup tables (deny-all except service_role) OR move to archive schema with no API exposure.",
    "Phase 8B-3 (approval): Recreate inventory + claim views WITH (security_invoker=true); verify org-scoped policies on return_items, expected_packages, claim_candidates.",
    "Phase 8B-4 (approval, 30d retention): DROP empty structural backups (_backup_* WHERE false) after manifest sign-off.",
    "Phase 8B-5 (approval, 90d retention): MOVE non-empty PIM backups to archive._backup_* then DROP public copies after parity verification export.",
  ];

  const summary = {
    prompt: "PHASE-8B-ORIGINAL-BACKUP-TABLES-RLS-AND-CLEANUP-AUDIT",
    run_id: runId,
    target_ref: ORIGINAL_REF,
    backup_tables_count: backupTablesReport.length,
    backup_tables_report: backupTablesReport,
    views_unrestricted_report: viewsReport,
    high_risk_objects: highRiskObjects,
    safe_cleanup_plan: safeCleanupPlan,
    requires_user_approval: "yes",
    next_prompt: "PHASE-8B-ORIGINAL-BACKUP-REVOKE-GRANTS-EXECUTE",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "01_backup_tables_report.md"),
    [
      "# Backup / audit tables (original)",
      "",
      `Count: **${backupTablesReport.length}**`,
      "",
      "| table | rows | size | RLS | public SELECT | sensitive | db ref | app ref | keep | archive | drop |",
      "|-------|------|------|-----|---------------|-----------|--------|---------|------|---------|------|",
      ...backupTablesReport.map(
        (t) =>
          `| ${t.table_name} | ${t.row_count ?? "?"} | ${t.size_pretty} | ${t.rls_enabled ? "yes" : "no"} | ${
            t.public_permissions.anon?.includes("SELECT") ||
            t.public_permissions.authenticated?.includes("SELECT")
              ? "yes"
              : "no"
          } | ${t.contains_sensitive_data ? "yes" : "no"} | ${t.referenced_by_db ? "yes" : "no"} | ${t.referenced_by_app ? "yes" : "no"} | ${t.safe_to_keep ? "yes" : "no"} | ${t.safe_to_archive_schema ? "yes" : "no"} | ${t.safe_to_drop ? "yes" : "no"} |`,
      ),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(outDir, "02_views_unrestricted_report.md"),
    [
      "# Unrestricted / API-exposed views (original)",
      "",
      "| view | category | security_invoker | leak risk | underlying RLS gaps | app ref |",
      "|------|----------|------------------|-----------|---------------------|---------|",
      ...viewsReport.map((v) => {
        const rlsGaps = Object.entries(v.underlying_rls)
          .filter(([, on]) => !on)
          .map(([t]) => t)
          .join(", ");
        return `| ${v.view_name} | ${v.category} | ${v.security_invoker === null ? "default(definer)" : v.security_invoker} | ${v.data_leak_risk} | ${rlsGaps || "none"} | ${v.referenced_by_app ? "yes" : "no"} |`;
      }),
      "",
      "## Recommended fixes",
      ...viewsReport.map((v) => `- **${v.view_name}**: ${v.recommended_fix}`),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(outDir, "03_safe_cleanup_plan.md"),
    ["# Safe cleanup plan", "", ...safeCleanupPlan.map((s, i) => `${i + 1}. ${s}`)].join("\n") + "\n",
  );

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
