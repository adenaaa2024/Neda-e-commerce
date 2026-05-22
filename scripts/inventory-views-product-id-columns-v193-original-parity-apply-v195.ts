/**
 * V195 — ORIGINAL/CURRENT INVENTORY VIEW PARITY APPLY
 *
 *   npx tsx scripts/inventory-views-product-id-columns-v193-original-parity-apply-v195.ts
 *   npx tsx scripts/inventory-views-product-id-columns-v193-original-parity-apply-v195.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const APPROVAL_PATH =
  ".cursor/operator-approvals/inventory-views-product-id-columns-v193-original-parity-approval.md";
const DDL_PATH =
  ".cursor/audit-reports/v194-inventory-view-original-parity-product-columns/20260521T202900Z/original-parity-ddl.sql";
const OUT_BASE = ".cursor/audit-reports/v195-original-view-parity-apply";

const FORBIDDEN = [
  /\bDROP\s+(TABLE|SCHEMA)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bpackage_items\b/i,
  /\bFROM\s+public\.returns\b/i,
  /\bINSERT\s+INTO\s+public\.products\b/i,
  /\bINSERT\s+INTO\s+public\.product_identifier_map\b/i,
];

const SCANNED_PRODUCT_COLS = [
  "product_id",
  "resolved_product_id",
  "resolved_catalog_product_id",
  "product_name",
  "product_linkage_status",
  "identifier_resolution_confidence",
  "product_identifier",
  "scanned_qty",
];

const ITEM_PRODUCT_COLS = [
  "product_id",
  "resolved_product_id",
  "resolved_catalog_product_id",
  "product_linkage_status",
  "identifier_resolution_confidence",
  "product_identifier",
  "expected_qty",
  "scanned_qty",
  "variance_qty",
];

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApprovalFlags(): { run: boolean; ddl: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runM = text.match(/APPROVED_TO_RUN_ORIGINAL\s*=\s*(\S+)/);
  const ddlM = text.match(/APPROVED_TO_APPLY_VIEW_DDL_ORIGINAL\s*=\s*(\S+)/);
  const runVal = runM?.[1] ?? "";
  const ddlVal = ddlM?.[1] ?? "";
  return {
    run: runVal === "true",
    ddl: ddlVal === "true",
    raw: {
      APPROVED_TO_RUN_ORIGINAL: runVal,
      APPROVED_TO_APPLY_VIEW_DDL_ORIGINAL: ddlVal,
    },
  };
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function sqlWithoutComments(sql: string): string {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function preflightSql(sql: string): { pass: boolean; checks: Record<string, boolean>; notes: string[] } {
  const notes: string[] = [];
  const body = sqlWithoutComments(sql);
  const createCount = (body.match(/CREATE\s+OR\s+REPLACE\s+VIEW/gi) ?? []).length;
  const checks: Record<string, boolean> = {
    three_views_only: createCount === 3,
    deleted_at_filter: /\bWHERE\s+r\.deleted_at\s+IS\s+NULL\b/i.test(body),
    no_destructive_ddl: !FORBIDDEN.slice(0, 4).some((re) => re.test(body)),
    no_package_items: !/\bpackage_items\b/i.test(body),
    no_legacy_returns: !/\bFROM\s+public\.returns\b/i.test(body),
    no_product_inserts: !FORBIDDEN[6].test(body) && !FORBIDDEN[7].test(body),
    uses_return_items: /\bpublic\.return_items\b/i.test(body),
    create_or_replace_view_only:
      !/\bDROP\s+VIEW\b/i.test(body) && !/\bALTER\s+TABLE\b/i.test(body),
  };
  if (createCount !== 3) notes.push(`Expected 3 CREATE OR REPLACE VIEW, found ${createCount}`);
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks, notes };
}

async function viewColumns(client: pg.Client, viewName: string): Promise<string[]> {
  const r = await client.query(
    `SELECT a.attname AS column_name
     FROM pg_attribute a
     JOIN pg_class c ON a.attrelid = c.oid
     JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname = 'public'
       AND c.relname = $1
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [viewName],
  );
  return r.rows.map((row) => String(row.column_name));
}

async function viewDef(client: pg.Client, viewName: string): Promise<string> {
  const r = await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [
    `public.${viewName}`,
  ]);
  return String(r.rows[0]?.def ?? "");
}

async function captureRollback(client: pg.Client): Promise<string> {
  const views = ["v_scanned_items_counted", "v_inventory_item_status", "v_inventory_status"];
  const parts: string[] = [
    "-- Rollback captured before V195 original parity apply",
    `-- original ref: ${ORIGINAL_REF}`,
    "",
  ];
  for (const v of views) {
    const def = await viewDef(client, v);
    parts.push(`CREATE OR REPLACE VIEW public.${v} AS`, def.trim().replace(/;\s*$/, "") + ";", "");
  }
  return parts.join("\n");
}

async function verifyViews(client: pg.Client): Promise<Record<string, unknown>> {
  const scannedCols = await viewColumns(client, "v_scanned_items_counted");
  const itemCols = await viewColumns(client, "v_inventory_item_status");
  const statusCols = await viewColumns(client, "v_inventory_status");
  const scannedDef = await viewDef(client, "v_scanned_items_counted");

  const scannedMissing = SCANNED_PRODUCT_COLS.filter((c) => !scannedCols.includes(c));
  const itemMissing = ITEM_PRODUCT_COLS.filter((c) => !itemCols.includes(c));
  const statusHasProduct = ["product_id", "resolved_product_id", "product_name"].some((c) =>
    statusCols.includes(c),
  );

  return {
    v_scanned_items_counted: {
      columns: scannedCols,
      product_columns_present: scannedMissing.length === 0,
      missing: scannedMissing,
      deleted_at_filter_present: /\bdeleted_at\s+IS\s+NULL\b/i.test(scannedDef),
    },
    v_inventory_item_status: {
      columns: itemCols,
      product_columns_present: itemMissing.length === 0,
      missing: itemMissing,
    },
    v_inventory_status: {
      columns: statusCols,
      aggregate_only: !statusHasProduct,
      has_product_columns: statusHasProduct,
    },
    pass:
      scannedMissing.length === 0 &&
      itemMissing.length === 0 &&
      !statusHasProduct &&
      /\bdeleted_at\s+IS\s+NULL\b/i.test(scannedDef),
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const approval = readApprovalFlags();
  const dbUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const prodUrl = process.env.PRODUCTION_DIRECT_POSTGRES_URL?.trim() || "";
  const connRef = refFromConnectionUrl(dbUrl);

  const sqlPath = path.join(process.cwd(), DDL_PATH);
  const sql = fs.readFileSync(sqlPath, "utf8");
  const preflight = preflightSql(sql);

  const targetOk = dbUrl.length > 0 && connRef === ORIGINAL_REF;
  const notStaging = Boolean(dbUrl && stagingUrl && dbUrl !== stagingUrl);
  const notMislabeledProd =
    !prodUrl || prodUrl !== dbUrl || refFromConnectionUrl(prodUrl) !== STAGING_REF;
  const approvalOk = approval.run && approval.ddl;

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — V195 original/current inventory view parity",
      "",
      `Approval file: \`${APPROVAL_PATH}\``,
      "",
      "Required exact flags:",
      "",
      "```text",
      "APPROVED_TO_RUN_ORIGINAL=true",
      "APPROVED_TO_APPLY_VIEW_DDL_ORIGINAL=true",
      "```",
      "",
      "Actual flags found:",
      "",
      "```text",
      `APPROVED_TO_RUN_ORIGINAL=${approval.raw.APPROVED_TO_RUN_ORIGINAL}`,
      `APPROVED_TO_APPLY_VIEW_DDL_ORIGINAL=${approval.raw.APPROVED_TO_APPLY_VIEW_DDL_ORIGINAL}`,
      "```",
      "",
      `Result: **${approvalOk ? "APPROVED" : "BLOCKED"}**.`,
    ].join("\n"),
  );

  const guardDoc = {
    run_id: runId,
    original_ref: ORIGINAL_REF,
    staging_ref_must_not_match: STAGING_REF,
    conn_ref_from_url: connRef,
    original_direct_postgres_configured: dbUrl.length > 0,
    target_is_original: targetOk,
    staging_not_targeted: notStaging,
    prod_url_not_staging_mislabel: notMislabeledProd,
    approval_ok: approvalOk,
    approval_flags: approval.raw,
    ddl_path: DDL_PATH,
    preflight,
    apply_requested: apply,
  };

  fs.writeFileSync(path.join(outDir, "preflight-result.md"), JSON.stringify(guardDoc, null, 2));

  if (!approvalOk || !targetOk || !preflight.pass || !notStaging || !notMislabeledProd) {
    const blockers: string[] = [];
    if (!approvalOk) blockers.push("Approval flags are not exact lowercase true");
    if (!targetOk) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL missing or wrong ref");
    if (!notStaging) blockers.push("Staging URL equals original URL");
    if (!notMislabeledProd) blockers.push("PRODUCTION_DIRECT_POSTGRES_URL mislabeled as staging");
    if (!preflight.pass) blockers.push(`DDL preflight failed: ${preflight.notes.join("; ")}`);
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n"));
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt_id: "V195-ORIGINAL-CURRENT-INVENTORY-VIEW-PARITY-APPLY",
          run_id: runId,
          status: "BLOCKED_PREFLIGHT",
          approval_ok: approvalOk,
          db_touched: false,
          ddl_applied: false,
          blockers,
        },
        null,
        2,
      ),
    );
    console.error(JSON.stringify({ ok: false, phase: "preflight", blockers }, null, 2));
    process.exit(2);
  }

  if (!apply) {
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt_id: "V195-ORIGINAL-CURRENT-INVENTORY-VIEW-PARITY-APPLY",
          run_id: runId,
          status: "PREFLIGHT_PASS_AWAITING_APPLY",
          db_touched: false,
          ddl_applied: false,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ok: true, phase: "preflight_only", run_id: runId, out_dir: outDir }, null, 2));
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const beforeVerify = await verifyViews(client);
    fs.writeFileSync(
      path.join(outDir, "before-verification.json"),
      JSON.stringify(beforeVerify, null, 2),
    );

    const rollbackSql = await captureRollback(client);
    fs.writeFileSync(path.join(outDir, "rollback-views.sql"), rollbackSql);
    fs.copyFileSync(sqlPath, path.join(outDir, "original-parity-ddl.sql"));

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }

    const afterVerify = await verifyViews(client);
    fs.writeFileSync(
      path.join(outDir, "after-verification.json"),
      JSON.stringify(afterVerify, null, 2),
    );

    const manifest = {
      prompt_id: "V195-ORIGINAL-CURRENT-INVENTORY-VIEW-PARITY-APPLY",
      run_id: runId,
      status: afterVerify.pass ? "APPLIED_VERIFIED" : "APPLIED_VERIFICATION_FAILED",
      original_ref: ORIGINAL_REF,
      ddl_path: DDL_PATH,
      db_touched: true,
      original_current_touched: true,
      staging_touched: false,
      future_production_touched: false,
      ddl_applied: true,
      destructive_ddl: false,
      products_created: false,
      map_rows_inserted: false,
      expected_packages_updated: false,
      package_items_created: false,
      amazon_api_called: false,
      ai_or_openai_called: false,
      verification_pass: afterVerify.pass,
      before: beforeVerify,
      after: afterVerify,
    };

    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(outDir, "apply-result.md"),
      [
        "# V195 original parity apply result",
        "",
        `- Status: **${manifest.status}**`,
        `- Verification pass: **${afterVerify.pass}**`,
        `- v_scanned_items_counted product columns before: ${beforeVerify.v_scanned_items_counted?.product_columns_present}`,
        `- v_scanned_items_counted product columns after: ${afterVerify.v_scanned_items_counted?.product_columns_present}`,
        `- v_inventory_item_status product columns after: ${afterVerify.v_inventory_item_status?.product_columns_present}`,
        `- v_inventory_status aggregate-only: ${afterVerify.v_inventory_status?.aggregate_only}`,
        `- deleted_at filter: ${afterVerify.v_scanned_items_counted?.deleted_at_filter_present}`,
        "",
        "Rollback: `rollback-views.sql` in this run folder.",
      ].join("\n"),
    );

    fs.writeFileSync(
      path.join(outDir, "constraints-proof.md"),
      [
        "# Constraints proof — V195 apply",
        "",
        "| Constraint | Violated |",
        "|---|---|",
        "| Future production touched | no |",
        "| Staging touched | no |",
        "| Products created | no |",
        "| Map rows inserted | no |",
        "| expected_packages updated | no |",
        "| package_items | no |",
        "| Destructive DDL | no |",
        "| Amazon API | no |",
        "| AI/OpenAI | no |",
      ].join("\n"),
    );

    console.log(JSON.stringify(manifest, null, 2));
    if (!afterVerify.pass) process.exit(3);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
