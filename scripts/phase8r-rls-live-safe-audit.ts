/**
 * PHASE-8R-RLS-LIVE-SAFE-AUDIT (read-only)
 * Target: original/live kxsvedvpjldygtdbylsy
 *
 *   npx tsx scripts/phase8r-rls-live-safe-audit.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/phase8r-rls-live-safe-audit";

type Domain =
  | "scanner"
  | "product_pim"
  | "claims"
  | "amazon_import"
  | "platform_automation"
  | "frr_trid"
  | "storage_evidence"
  | "org_rbac"
  | "backup"
  | "other";

type TableRlsAudit = {
  table: string;
  domain: Domain;
  rls_enabled: boolean;
  policy_count: number;
  has_service_role_bypass: boolean;
  has_org_policy: boolean;
  has_organization_id: boolean;
  has_store_id: boolean;
  required_user_access: string;
  service_role_import_access: string;
  scope_columns: string;
  risk_if_enabled_or_tightened: "low" | "medium" | "high" | "critical";
  policy_needed: string;
  can_apply_phase1: boolean;
  phase1_block_reason: string | null;
  row_estimate: number | null;
};

const SCANNER = new Set([
  "expected_packages",
  "return_items",
  "packages",
  "pallets",
  "slip_contents",
  "shipment_containers",
  "shipment_boxes",
  "shipment_box_items",
  "removal_item_allocations",
]);

const PRODUCT_PIM = new Set([
  "products",
  "product_identifier_map",
  "product_prices",
  "vendors",
  "product_categories",
  "product_category_links",
  "brands",
  "catalog_products",
  "pim_duplicate_groups",
  "pim_conflict_audit_log",
  "pim_import_sessions",
  "pim_identifier_authority_policy",
  "pim_identifier_dispute",
  "pim_conflict_review_event",
  "pim_canonical_lifecycle_event",
  "product_packaging_profiles",
  "product_packaging_evidence",
  "product_packaging_dimensions_current",
  "product_identity_staging_rows",
]);

const CLAIMS = new Set([
  "claim_candidates",
  "claim_candidate_drafts",
  "claim_lines",
  "claim_cases",
  "claim_case_events",
  "claim_evidence",
  "claim_reference_edges",
  "claim_filing_requests",
  "claim_filing_request_events",
  "claim_submissions",
  "claim_review_work_items",
  "claim_review_work_item_events",
  "claim_company_routing_rules",
  "claim_sla_rules",
  "claim_reimbursements",
  "claim_enrichment_generations",
  "claim_enrichment_freeze_state",
  "claim_evidence_draft_operator_state",
  "claim_reference_edge_bulk_review_events",
  "claim_reference_edge_review_events",
  "claim_filing_packet_preview_events",
  "claim_evidence_lineage_events",
  "claim_history_logs",
  "financial_reference_resolver",
]);

const PLATFORM = new Set([
  "platform_settings",
  "organization_settings",
  "workspace_settings",
  "system_settings",
  "organization_api_keys",
  "marketplaces",
  "import_mapping_defaults",
  "import_pipeline_locks",
  "file_processing_status",
  "raw_report_uploads",
  "async_jobs",
  "async_job_events",
  "platform_automation_import_runs",
  "organization_modules",
  "organization_module_features",
  "modules",
  "module_features",
]);

const FRR_TRID = new Set([
  "financial_reference_resolver",
  "trid_entities",
  "trid_links",
  "trid_events",
  "audit_events",
  "undo_snapshots",
]);

const STORAGE_EVIDENCE = new Set([
  "claim_evidence",
  "product_packaging_evidence",
  "audit_events",
  "undo_snapshots",
]);

const PHASE1_CANDIDATES = new Set([
  "permissions",
  "role_permissions",
  "group_permissions",
  "roles",
  "groups",
  "profiles",
  "organizations",
  "stores",
  "user_store_assignments",
  "vendors",
  "product_categories",
  "product_prices",
  "pim_duplicate_groups",
  "pim_conflict_audit_log",
  "pim_import_sessions",
  "pim_identifier_authority_policy",
  "pim_identifier_dispute",
  "pim_conflict_review_event",
  "pim_canonical_lifecycle_event",
  "catalog_products",
  "warehouses",
  "organization_settings",
  "claim_company_routing_rules",
  "claim_sla_rules",
]);

const NEVER_PHASE1 = new Set([
  "expected_packages",
  "return_items",
  "packages",
  "pallets",
  "slip_contents",
  "products",
  "product_identifier_map",
  "claim_candidates",
  "amazon_staging",
  "financial_reference_resolver",
  "raw_report_uploads",
  "marketplaces",
  "organization_api_keys",
  "workspace_settings",
  "returns",
]);

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function domainFor(table: string): Domain {
  if (table.startsWith("_backup") || table.startsWith("backup_")) return "backup";
  if (SCANNER.has(table)) return "scanner";
  if (CLAIMS.has(table)) return "claims";
  if (PRODUCT_PIM.has(table)) return "product_pim";
  if (table.startsWith("amazon_")) return "amazon_import";
  if (PLATFORM.has(table)) return "platform_automation";
  if (FRR_TRID.has(table)) return "frr_trid";
  if (STORAGE_EVIDENCE.has(table)) return "storage_evidence";
  if (["profiles", "organizations", "stores", "permissions", "roles"].includes(table)) return "org_rbac";
  return "other";
}

function classifyTable(
  table: string,
  rls: boolean,
  policyCount: number,
  hasSrBypass: boolean,
  hasOrgPolicy: boolean,
  hasOrg: boolean,
  hasStore: boolean,
): Omit<TableRlsAudit, "table" | "domain" | "row_estimate"> {
  const dom = domainFor(table);

  let userAccess = "authenticated org member SELECT/WRITE";
  let srAccess = "service_role bypass required for imports/cron";
  let policyNeeded = "org member policies + service_role bypass";
  let risk: TableRlsAudit["risk_if_enabled_or_tightened"] = "medium";
  let canP1 = false;
  let blockReason: string | null = null;

  if (dom === "backup") {
    return {
      rls_enabled: rls,
      policy_count: policyCount,
      has_service_role_bypass: hasSrBypass,
      has_org_policy: hasOrgPolicy,
      has_organization_id: hasOrg,
      has_store_id: hasStore,
      required_user_access: "none — revoke authenticated grants",
      service_role_import_access: "service_role only",
      scope_columns: hasOrg ? "organization_id" : "—",
      risk_if_enabled_or_tightened: "low",
      policy_needed: "service_role-only or drop after retention",
      can_apply_phase1: false,
      phase1_block_reason: "backup table — not in live rollout scope",
    };
  }

  if (dom === "scanner") {
    userAccess = "scanner operator org+store scoped";
    risk = "critical";
    blockReason = "Requires user_can_access_store() helper + scanner smoke before any policy change";
    policyNeeded = "org + store assignment policy; service_role bypass for server actions";
  } else if (dom === "product_pim") {
    if (table === "products" || table === "product_identifier_map") {
      risk = "critical";
      blockReason = "Scanner resolver + import bulk upsert depend on service_role or broad read";
    } else if (PHASE1_CANDIDATES.has(table)) {
      risk = "low";
      canP1 = true;
    }
    userAccess = "PIM authenticated org member";
    policyNeeded = "org-scoped CRUD + service_role bypass";
  } else if (dom === "claims") {
    userAccess = "claims UI authenticated org member";
    if (table === "claim_candidates" && !rls) {
      risk = "high";
      blockReason = "RLS disabled — enabling without policies blocks inbox; needs org SELECT + service_role bypass first";
    } else if (table === "financial_reference_resolver") {
      userAccess = "internal only";
      srAccess = "service_role only — 560k+ rows";
      risk = "critical";
      blockReason = "FRR bulk ingest via service_role; never expose to authenticated direct SELECT";
      policyNeeded = "service_role-only policy";
    } else if (PHASE1_CANDIDATES.has(table)) {
      canP1 = !rls || (rls && policyCount > 0 && hasSrBypass);
      risk = "medium";
    } else {
      risk = "high";
    }
    policyNeeded = "org-scoped SELECT + service_role bypass for workers";
  } else if (dom === "amazon_import") {
    userAccess = "admin read optional; no anon";
    srAccess = "service_role required for ETL/sync";
    risk = "high";
    blockReason = blockReason ?? "Import pipelines use service_role; authenticated policies must not block rebuild RPCs";
    policyNeeded = "service_role bypass + optional org SELECT for admin UI";
  } else if (dom === "platform_automation") {
    if (table === "organization_api_keys" || table === "marketplaces") {
      userAccess = "admin metadata only — no secret columns";
      risk = "critical";
      blockReason = "Credential exposure risk if authenticated SELECT too broad";
      policyNeeded = "service_role-only or redacted view";
    } else if (table === "platform_settings") {
      userAccess = "authenticated read (PWA)";
      canP1 = !rls;
      risk = "low";
      policyNeeded = "authenticated SELECT singleton; no anon";
    } else if (table === "workspace_settings") {
      risk = "high";
      blockReason = "Current authenticated-ALL policy too permissive — fix before tighten";
    } else {
      srAccess = "service_role for import/automation";
      risk = "high";
    }
  } else if (dom === "frr_trid") {
    userAccess = table === "audit_events" ? "org admin read" : "admin/service_role";
    risk = "high";
    policyNeeded = "org-scoped read; append via SECURITY DEFINER RPC";
  }

  if (NEVER_PHASE1.has(table)) {
    canP1 = false;
    if (!blockReason) blockReason = "Explicitly blocked from Phase 1 live rollout";
  }

  if (PHASE1_CANDIDATES.has(table) && !NEVER_PHASE1.has(table) && dom !== "scanner") {
    if (rls && policyCount === 0) {
      canP1 = true;
      blockReason = blockReason ?? "RLS on with zero policies — add org + service_role policies (safe additive)";
      risk = "high";
    } else if (!rls) {
      canP1 = true;
      blockReason = null;
    } else if (rls && policyCount > 0 && hasSrBypass) {
      canP1 = true;
      blockReason = null;
    } else if (rls && policyCount > 0 && !hasSrBypass) {
      canP1 = false;
      blockReason = blockReason ?? "Missing service_role bypass — import workers would break";
    }
  }

  if (dom === "org_rbac" || table === "user_store_assignments") {
    canP1 = true;
    risk = "low";
    blockReason = null;
  }

  const scope = [hasOrg ? "organization_id" : null, hasStore ? "store_id" : null].filter(Boolean).join(", ") || "—";

  return {
    rls_enabled: rls,
    policy_count: policyCount,
    has_service_role_bypass: hasSrBypass,
    has_org_policy: hasOrgPolicy,
    has_organization_id: hasOrg,
    has_store_id: hasStore,
    required_user_access: userAccess,
    service_role_import_access: srAccess,
    scope_columns: scope,
    risk_if_enabled_or_tightened: risk,
    policy_needed: policyNeeded,
    can_apply_phase1: canP1,
    phase1_block_reason: blockReason,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL required");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const tablesRes = await client.query(`
    SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
           COALESCE(s.n_live_tup, 0)::bigint AS row_estimate
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);

  const policiesRes = await client.query(`
    SELECT tablename, policyname, roles, cmd, qual
    FROM pg_policies WHERE schemaname = 'public'
  `);

  const colsRes = await client.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN ('organization_id', 'store_id')
  `);

  const storagePol = await client.query(`
    SELECT tablename, policyname, roles, cmd FROM pg_policies WHERE schemaname = 'storage'
  `);

  const buckets = await client.query(`SELECT id, name, public FROM storage.buckets ORDER BY name`);

  await client.end();

  const colsByTable = new Map<string, Set<string>>();
  for (const r of colsRes.rows as { table_name: string; column_name: string }[]) {
    const s = colsByTable.get(r.table_name) ?? new Set();
    s.add(r.column_name);
    colsByTable.set(r.table_name, s);
  }

  const policiesByTable = new Map<string, typeof policiesRes.rows>();
  for (const p of policiesRes.rows as { tablename: string; policyname: string; roles: string; cmd: string; qual: string }[]) {
    const list = policiesByTable.get(p.tablename) ?? [];
    list.push(p);
    policiesByTable.set(p.tablename, list);
  }

  const audits: TableRlsAudit[] = [];
  for (const row of tablesRes.rows as { table_name: string; rls_enabled: boolean; row_estimate: string }[]) {
    const table = row.table_name;
    if (domainFor(table) === "backup") continue; // exclude from live rollout matrix

    const policies = policiesByTable.get(table) ?? [];
    const rolesStr = policies.map((p) => JSON.stringify(p.roles)).join(" ");
    const hasSrBypass = rolesStr.includes("service_role");
    const hasOrgPolicy = policies.some(
      (p) =>
        (p.qual ?? "").includes("organization_id") ||
        (p.qual ?? "").includes("get_my_organization_id") ||
        p.policyname.includes("org"),
    );
    const cols = colsByTable.get(table) ?? new Set();
    const classified = classifyTable(
      table,
      row.rls_enabled,
      policies.length,
      hasSrBypass,
      hasOrgPolicy,
      cols.has("organization_id"),
      cols.has("store_id"),
    );
    audits.push({
      table,
      domain: domainFor(table),
      row_estimate: Number(row.row_estimate) || null,
      ...classified,
    });
  }

  const rlsEnabled = audits.filter((a) => a.rls_enabled).map((a) => a.table);
  const rlsMissing = audits.filter((a) => !a.rls_enabled).map((a) => a.table);
  const highRisk = audits.filter((a) => a.risk_if_enabled_or_tightened === "critical" || a.risk_if_enabled_or_tightened === "high");
  const scannerBreak = audits.filter((a) => a.domain === "scanner");
  const apiWorkerBreak = audits.filter(
    (a) =>
      a.domain === "amazon_import" ||
      a.domain === "platform_automation" ||
      (a.table === "financial_reference_resolver") ||
      (!a.has_service_role_bypass && a.rls_enabled && a.policy_count > 0),
  );
  const claimBreak = audits.filter((a) => a.domain === "claims" && (!a.rls_enabled || !a.has_service_role_bypass));
  const phase1Safe = audits.filter((a) => a.can_apply_phase1);
  const phase1Blocked = audits.filter((a) => !a.can_apply_phase1 && a.domain !== "backup");

  const criticalMissingRls = ["claim_candidates", "claim_cases", "groups", "roles"].filter((t) =>
    rlsMissing.includes(t),
  );

  const safePhase1 =
    criticalMissingRls.length === 0 &&
    phase1Safe.length >= 15 &&
    !phase1Safe.some((t) => NEVER_PHASE1.has(t.table));

  const blockers = [
    ...(criticalMissingRls.length ? [`Enable RLS+policies on: ${criticalMissingRls.join(", ")} before claiming hardened`] : []),
    "Scanner tables (EP, return_items, packages, pallets) blocked until user_can_access_store() + smoke pass",
    "products/product_identifier_map: service_role bypass must remain on any authenticated policy",
    "financial_reference_resolver: service_role-only — never authenticated broad SELECT",
    "marketplaces/organization_api_keys: credential lockdown before authenticated policies",
    "Tables with RLS on + zero policies block all non-service-role clients (vendors, product_prices, product_categories on original)",
    "Storage: public SELECT on storage.objects — separate from table RLS",
    "Staging proof gate for each Phase 1 batch before original apply",
  ];

  const phase8rPct = Math.round(
    ((rlsEnabled.length / audits.length) * 40 +
      (audits.filter((a) => a.has_service_role_bypass && a.rls_enabled).length / Math.max(rlsEnabled.length, 1)) * 30 +
      (phase1Safe.length / 25) * 30) *
      (safePhase1 ? 1 : 0.85),
  );

  const md = [
    "# Phase 8R — RLS live-safe audit",
    "",
    `**Target:** \`${ORIGINAL_REF}\` (production/live)  `,
    `**Run:** \`${runId}\`  `,
    "**Mode:** audit only — no RLS/policy changes",
    "",
    "## Summary",
    "",
    `| Metric | Count |`,
    `|--------|------:|`,
    `| Tables audited (excl backup) | ${audits.length} |`,
    `| RLS enabled | ${rlsEnabled.length} |`,
    `| RLS missing | ${rlsMissing.length} |`,
    `| High/critical risk | ${highRisk.length} |`,
    `| Phase 1 safe | ${phase1Safe.length} |`,
    `| Phase 1 blocked | ${phase1Blocked.length} |`,
    "",
    "## By domain",
    "",
    ...(["scanner", "product_pim", "claims", "amazon_import", "platform_automation", "frr_trid", "org_rbac", "other"] as Domain[]).map(
      (d) => {
        const rows = audits.filter((a) => a.domain === d);
        return `### ${d} (${rows.length})\n\n| Table | RLS | Policies | SR bypass | Phase1 | Risk |\n|-------|-----|----------|-----------|--------|------|\n${rows
          .map(
            (a) =>
              `| \`${a.table}\` | ${a.rls_enabled ? "yes" : "**no**"} | ${a.policy_count} | ${a.has_service_role_bypass ? "yes" : "no"} | ${a.can_apply_phase1 ? "yes" : "no"} | ${a.risk_if_enabled_or_tightened} |`,
          )
          .join("\n")}`;
      },
    ),
    "",
    "## Storage / evidence",
    "",
    `Buckets: ${(buckets.rows as { name: string; public: boolean }[]).map((b) => `${b.name}(public=${b.public})`).join(", ")}`,
    "",
    "Storage policies:",
    ...(storagePol.rows as { tablename: string; policyname: string; roles: string; cmd: string }[]).map(
      (p) => `- \`${p.tablename}.${p.policyname}\` (${p.cmd}) roles=${p.roles}`,
    ),
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "01_rls_live_safe_inventory.md"), md + "\n");
  fs.writeFileSync(path.join(outDir, "02_phase1_safe_tables.json"), JSON.stringify(phase1Safe.map((a) => a.table), null, 2));
  fs.writeFileSync(path.join(outDir, "03_phase1_blocked_tables.json"), JSON.stringify(
    phase1Blocked.map((a) => ({ table: a.table, reason: a.phase1_block_reason })),
    null,
    2,
  ));
  fs.writeFileSync(path.join(outDir, "table_audits.json"), JSON.stringify(audits, null, 2));

  const summary = {
    prompt: "PHASE-8R-RLS-LIVE-SAFE-AUDIT",
    run_id: runId,
    target_ref: ORIGINAL_REF,
    phase_number: "8R",
    rls_enabled_tables: rlsEnabled,
    rls_missing_tables: rlsMissing,
    high_risk_tables: highRisk.map((a) => a.table),
    scanner_break_risks: scannerBreak.map((a) => ({
      table: a.table,
      rls: a.rls_enabled,
      policies: a.policy_count,
      reason: a.phase1_block_reason,
    })),
    api_worker_break_risks: apiWorkerBreak.slice(0, 25).map((a) => ({
      table: a.table,
      domain: a.domain,
      sr_bypass: a.has_service_role_bypass,
      reason: a.phase1_block_reason ?? a.policy_needed,
    })),
    claim_break_risks: claimBreak.map((a) => ({
      table: a.table,
      rls: a.rls_enabled,
      policies: a.policy_count,
      sr_bypass: a.has_service_role_bypass,
    })),
    phase1_safe_tables: phase1Safe.map((a) => a.table),
    phase1_blocked_tables: phase1Blocked.map((a) => ({ table: a.table, reason: a.phase1_block_reason })),
    SAFE_TO_APPLY_RLS_PHASE1: safePhase1 ? "yes" : "no",
    new_phase_8r_percent: Math.min(phase8rPct, 100),
    blockers,
    tables_audited: audits.length,
    no_db_writes: true,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "implementation-summary.md"),
    [
      "# Phase 8R implementation summary",
      "",
      `**SAFE_TO_APPLY_RLS_PHASE1:** ${safePhase1 ? "yes" : "no"}`,
      `**new_phase_8r_percent:** ${Math.min(phase8rPct, 100)}`,
      "",
      "## Phase 1 safe (apply first on staging)",
      "",
      phase1Safe.map((a) => `- \`${a.table}\``).join("\n"),
      "",
      "## Do not touch in Phase 1",
      "",
      ...NEVER_PHASE1.values().map((t) => `- \`${t}\``),
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
