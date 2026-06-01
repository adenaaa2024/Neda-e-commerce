/**
 * ORIGINAL-CLAIM-SCHEMA-PARITY-CENSUS — read-only schema compare (staging vs original).
 *
 *   npx tsx scripts/original-claim-schema-parity-census.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/original-claim-schema-parity-census";

const TABLES = [
  "claim_lines",
  "claim_cases",
  "claim_evidence",
  "claim_case_events",
  "claim_company_routing_rules",
  "claim_sla_rules",
  "claim_grouping_policies",
  "claim_case_batches",
  "claim_batch_members",
  "claim_submissions",
] as const;

/** Columns required by lib/scanner-operator-claim-promote.ts when promote runs. */
const PROMOTE_REQUIRED: Record<string, string[]> = {
  claim_lines: [
    "id",
    "organization_id",
    "store_id",
    "return_item_id",
    "expected_package_id",
    "resolved_product_id",
    "package_id",
    "pallet_id",
    "order_id",
    "sku",
    "fnsku",
    "asin",
    "line_grain",
    "discrepancy_kind",
    "quantity_basis",
    "count_basis",
    "scanner_issue_type",
    "claim_case_id",
    "status",
    "status_reason",
    "idempotency_key",
    "metadata",
  ],
  claim_cases: [
    "id",
    "organization_id",
    "store_id",
    "claim_source",
    "scanner_issue_type",
    "status",
    "priority",
    "primary_return_item_id",
    "primary_package_id",
    "primary_resolved_product_id",
    "primary_order_id",
    "primary_sku",
    "primary_claim_line_id",
    "routed_company_key",
    "routed_company_display_name",
    "opened_by",
    "idempotency_key",
    "metadata",
  ],
  claim_evidence: [
    "id",
    "organization_id",
    "claim_case_id",
    "claim_line_id",
    "return_item_id",
    "package_id",
    "product_id",
    "evidence_kind",
    "capture_source",
    "scanner_issue_type",
    "public_url",
    "operator_note",
    "captured_by",
    "metadata",
  ],
  claim_case_events: [
    "id",
    "organization_id",
    "claim_case_id",
    "event_type",
    "from_status",
    "to_status",
    "actor_id",
    "payload",
  ],
  claim_company_routing_rules: [
    "id",
    "organization_id",
    "store_id",
    "claim_source",
    "scanner_issue_type",
    "routed_company_key",
    "routed_company_display_name",
    "is_active",
    "priority",
  ],
};

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

type TableInfo = {
  exists: boolean;
  columns: string[];
  row_count: number | null;
};

async function introspect(client: pg.Client, table: string): Promise<TableInfo> {
  const reg = await client.query(`SELECT to_regclass($1) AS oid`, [`public.${table}`]);
  const exists = Boolean(reg.rows[0]?.oid);
  if (!exists) return { exists: false, columns: [], row_count: null };

  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  const columns = cols.rows.map((r) => String((r as { column_name: string }).column_name));

  let row_count: number | null = null;
  try {
    const cnt = await client.query(`SELECT COUNT(*)::bigint AS c FROM public.${table}`);
    row_count = Number((cnt.rows[0] as { c: string }).c);
  } catch {
    row_count = null;
  }

  return { exists: true, columns, row_count };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingRef = refFromConnectionUrl(stagingUrl) || refFromSupabaseUrl(process.env.STAGING_SUPABASE_URL ?? "");
  const originalRef = refFromConnectionUrl(originalUrl) || ORIGINAL_REF;

  const blockers: string[] = [];
  if (stagingRef !== STAGING_REF) blockers.push(`staging ref mismatch: ${stagingRef}`);
  if (originalRef !== ORIGINAL_REF) blockers.push(`original ref mismatch: ${originalRef}`);
  if (!stagingUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL missing");
  if (!originalUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL missing");

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), `# Blockers\n\n${blockers.map((b) => `- ${b}`).join("\n")}\n`);
    console.log(JSON.stringify({ pass: false, blockers, outDir }));
    process.exit(1);
  }

  const stagingClient = new pg.Client({ connectionString: stagingUrl });
  const originalClient = new pg.Client({ connectionString: originalUrl });
  await stagingClient.connect();
  await originalClient.connect();

  const staging: Record<string, TableInfo> = {};
  const original: Record<string, TableInfo> = {};

  for (const t of TABLES) {
    staging[t] = await introspect(stagingClient, t);
    original[t] = await introspect(originalClient, t);
  }

  await stagingClient.end();
  await originalClient.end();

  type Classification = "safe_present" | "missing_guarded_off" | "missing_may_crash" | "requires_migration";

  const rows: {
    table: string;
    staging_exists: boolean;
    original_exists: boolean;
    staging_cols_missing: string[];
    original_cols_missing: string[];
    classification: Classification;
    notes: string;
  }[] = [];

  for (const t of TABLES) {
    const s = staging[t]!;
    const o = original[t]!;
    const required = PROMOTE_REQUIRED[t] ?? [];
    const stagingMissing = required.filter((c) => s.exists && !s.columns.includes(c));
    const originalMissing = required.filter((c) => o.exists && !o.columns.includes(c));

    let classification: Classification;
    let notes: string;

    const inPromotePath = t in PROMOTE_REQUIRED;
    const groupingFuture = ["claim_grouping_policies", "claim_case_batches", "claim_batch_members", "claim_sla_rules"].includes(t);

    if (o.exists && originalMissing.length === 0) {
      classification = "safe_present";
      notes = "Table and promote columns present on original.";
    } else if (!o.exists && inPromotePath) {
      classification = "missing_guarded_off";
      notes =
        "Missing on original; scanner promote default OFF (CLAIM_SCANNER_AUTO_PROMOTE_ENABLED). No runtime query in app/ except promote helper.";
    } else if (!o.exists && t === "claim_submissions") {
      classification = "missing_may_crash";
      notes = "claim_submissions used by claim-engine UI — verify separately if absent.";
    } else if (!o.exists && groupingFuture) {
      classification = "missing_guarded_off";
      notes = "Not referenced in shipped app code; architecture/migration only.";
    } else if (o.exists && originalMissing.length > 0) {
      classification = "requires_migration";
      notes = `Partial table on original; missing columns: ${originalMissing.join(", ")}`;
    } else if (!o.exists) {
      classification = "missing_guarded_off";
      notes = "Not present on original; no active code path when promote off.";
    } else {
      classification = "safe_present";
      notes = "Present on original.";
    }

    rows.push({
      table: t,
      staging_exists: s.exists,
      original_exists: o.exists,
      staging_cols_missing: stagingMissing,
      original_cols_missing: originalMissing,
      classification,
      notes,
    });
  }

  const promoteTables = ["claim_lines", "claim_cases", "claim_evidence", "claim_case_events", "claim_company_routing_rules"];
  const originalPromoteReady = promoteTables.every((t) => {
    const o = original[t]!;
    const req = PROMOTE_REQUIRED[t] ?? [];
    return o.exists && req.every((c) => o.columns.includes(c));
  });

  const deploySafePromoteOff =
    rows
      .filter((r) => promoteTables.includes(r.table))
      .every(
        (r) =>
          r.classification === "missing_guarded_off" ||
          r.classification === "safe_present" ||
          (r.table === "claim_cases" && r.original_exists && r.classification === "requires_migration"),
      ) &&
    !rows.some((r) => r.table === "claim_submissions" && r.classification === "missing_may_crash");

  const migrationRequiredBeforeMerge = rows.some((r) => {
    if (r.classification === "missing_may_crash") return true;
    if (r.classification === "requires_migration" && r.table !== "claim_cases") return true;
    return false;
  });

  const migrationRequiredBeforePromoteOnOriginal = !originalPromoteReady;

  const manifest = {
    audit_id: "original-claim-schema-parity-census",
    run_id: rid,
    original_ref: originalRef,
    staging_ref: stagingRef,
    original_promote_schema_ready: originalPromoteReady,
    deploy_safe_with_scanner_promote_off: deploySafePromoteOff,
    migration_required_before_main_merge: migrationRequiredBeforeMerge,
    migration_required_before_promote_on_original: migrationRequiredBeforePromoteOnOriginal,
    tables: Object.fromEntries(
      TABLES.map((t) => [
        t,
        {
          staging: { exists: staging[t]!.exists, row_count: staging[t]!.row_count },
          original: { exists: original[t]!.exists, row_count: original[t]!.row_count },
        },
      ]),
    ),
    comparison: rows,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const md = [
    "# Original vs staging claim schema census",
    "",
    `**Run:** ${rid}`,
    `**Original ref:** ${originalRef}`,
    `**Staging ref:** ${stagingRef}`,
    "",
    "## Summary",
    "",
    `| Question | Answer |`,
    `|----------|--------|`,
    `| Original ref confirmed | ${originalRef === ORIGINAL_REF ? "YES" : "NO"} |`,
    `| Deploy code-safe with scanner promote OFF | ${deploySafePromoteOff ? "**YES**" : "**NO**"} |`,
    `| Migration required before main merge (for code deploy) | ${migrationRequiredBeforeMerge ? "**YES**" : "**NO**"} |`,
    `| Original ready if promote enabled | ${originalPromoteReady ? "YES" : "NO"} |`,
    "",
    "## Table comparison",
    "",
    "| Table | Staging | Original | Staging rows | Original rows | Classification |",
    "|-------|---------|----------|-------------:|--------------:|----------------|",
    ...rows.map(
      (r) =>
        `| ${r.table} | ${r.staging_exists ? "yes" : "no"} | ${r.original_exists ? "yes" : "no"} | ${staging[r.table]?.row_count ?? "—"} | ${original[r.table]?.row_count ?? "—"} | ${r.classification} |`,
    ),
    "",
    "## Missing promote columns on original",
    "",
    ...rows
      .filter((r) => r.original_cols_missing.length)
      .map((r) => `- **${r.table}:** ${r.original_cols_missing.join(", ")}`),
    ...(rows.every((r) => !r.original_cols_missing.length) ? ["- (none — or table absent)"] : []),
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "schema-census.md"), md + "\n");

  const columnDetail = Object.fromEntries(
    TABLES.filter((t) => original[t]!.exists || staging[t]!.exists).map((t) => [
      t,
      { staging_columns: staging[t]!.columns, original_columns: original[t]!.columns },
    ]),
  );
  fs.writeFileSync(path.join(outDir, "column-detail.json"), JSON.stringify(columnDetail, null, 2));

  console.log(JSON.stringify({ pass: true, run_id: rid, outDir, manifest }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
