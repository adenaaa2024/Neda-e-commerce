/**
 * MAIN V205 — Apply package_code inventory views on staging (approval-gated).
 *
 *   npx tsx scripts/main-v205-package-code-inventory-views-apply-staging.ts
 *   npx tsx scripts/main-v205-package-code-inventory-views-apply-staging.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const APPROVAL_PATH = ".cursor/operator-approvals/package-code-inventory-views-v204-approval.md";
const DDL_PATH =
  ".cursor/audit-reports/main-v204-package-code-view-ddl-plan/20260522T160000Z/ddl-plan.sql";
const OUT_BASE = ".cursor/audit-reports/main-v205-package-code-v-inventory-item-status-apply";

const VIEWS = ["v_scanned_items_counted", "v_inventory_item_status", "v_inventory_status"] as const;

const FORBIDDEN = [
  /\bDROP\s+(TABLE|SCHEMA)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+TABLE\b/i,
  /\bpackage_items\b/i,
  /\bFROM\s+public\.returns\b/i,
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
  const runM = text.match(/APPROVED_TO_RUN_STAGING\s*=\s*(\S+)/);
  const ddlM = text.match(/APPROVED_TO_APPLY_VIEW_DDL\s*=\s*(\S+)/);
  const runVal = runM?.[1] ?? "";
  const ddlVal = ddlM?.[1] ?? "";
  return {
    run: runVal === "true",
    ddl: ddlVal === "true",
    raw: {
      APPROVED_TO_RUN_STAGING: runVal,
      APPROVED_TO_APPLY_VIEW_DDL: ddlVal,
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
    package_code_in_item_view: /\bv_inventory_item_status\b[\s\S]*\bpackage_code\b/i.test(body),
    deleted_at_filter: /\bWHERE\s+r\.deleted_at\s+IS\s+NULL\b/i.test(body),
    no_destructive_ddl: !FORBIDDEN.slice(0, 4).some((re) => re.test(body)),
    no_package_items: !/\bpackage_items\b/i.test(body),
    no_legacy_returns: !/\bFROM\s+public\.returns\b/i.test(body),
    uses_return_items: /\bpublic\.return_items\b/i.test(body),
    create_or_replace_view_only: !/\bDROP\s+VIEW\b/i.test(body) && !/\bALTER\s+TABLE\b/i.test(body),
  };
  if (createCount !== 3) notes.push(`Expected 3 CREATE OR REPLACE VIEW, found ${createCount}`);
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks, notes };
}

async function captureRollback(client: pg.Client): Promise<string> {
  const parts: string[] = [
    "-- Rollback captured before MAIN V205 package_code view apply",
    `-- staging ref: ${STAGING_REF}`,
    "",
  ];
  for (const v of VIEWS) {
    const def = await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [`public.${v}`]);
    parts.push(
      `CREATE OR REPLACE VIEW public.${v} AS`,
      String(def.rows[0]?.def ?? "").trim().replace(/;\s*$/, "") + ";",
      "",
    );
  }
  return parts.join("\n");
}

async function viewColumns(client: pg.Client, viewName: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [viewName],
  );
  return r.rows.map((x: { column_name: string }) => x.column_name);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const approval = readApprovalFlags();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const prodUrl = process.env.PRODUCTION_DIRECT_POSTGRES_URL?.trim() || "";
  const connRef = refFromConnectionUrl(stagingUrl);

  const sql = fs.readFileSync(path.join(process.cwd(), DDL_PATH), "utf8");
  fs.copyFileSync(path.join(process.cwd(), DDL_PATH), path.join(outDir, "ddl-used.sql"));
  const preflight = preflightSql(sql);

  const approvalOk = approval.run && approval.ddl;
  const targetOk = stagingUrl.length > 0 && connRef === STAGING_REF;
  const notOriginal = !originalUrl || stagingUrl !== originalUrl;
  const notMislabeledProd = !prodUrl || prodUrl !== stagingUrl;

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — MAIN V205 package_code inventory views",
      "",
      `Approval file: \`${APPROVAL_PATH}\``,
      "",
      "Required exact flags:",
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=true",
      "APPROVED_TO_APPLY_VIEW_DDL=true",
      "```",
      "",
      "Actual flags found:",
      "",
      "```text",
      `APPROVED_TO_RUN_STAGING=${approval.raw.APPROVED_TO_RUN_STAGING}`,
      `APPROVED_TO_APPLY_VIEW_DDL=${approval.raw.APPROVED_TO_APPLY_VIEW_DDL}`,
      "```",
      "",
      `Result: **${approvalOk ? "APPROVED" : "BLOCKED"}**.`,
    ].join("\n"),
  );

  const blockers: string[] = [];
  if (!approvalOk) {
    blockers.push(
      "Operator approval flags are not both `true` in package-code-inventory-views-v204-approval.md (set both to true in sign-off block, not only the summary table)",
    );
  }
  if (!targetOk) blockers.push(`STAGING_DIRECT_POSTGRES_URL must resolve to ref ${STAGING_REF}`);
  if (!notOriginal) blockers.push("STAGING URL must not equal ORIGINAL_DIRECT_POSTGRES_URL");
  if (!notMislabeledProd) blockers.push("STAGING URL must not equal PRODUCTION_DIRECT_POSTGRES_URL");
  if (!preflight.pass) blockers.push("DDL preflight failed");

  let applied = false;
  let packageCodeExists = false;
  let queryProof: "PASS" | "PARTIAL" | "FAIL" = "FAIL";
  let preRollback = "";
  let postColumns: Record<string, string[]> = {};

  if (targetOk && notOriginal && stagingUrl) {
    const client = new pg.Client({ connectionString: stagingUrl });
    await client.connect();
    preRollback = await captureRollback(client);
    fs.writeFileSync(path.join(outDir, "pre-apply-viewdefs.sql"), preRollback);
    fs.writeFileSync(path.join(outDir, "rollback-viewdefs.sql"), preRollback);

    if (apply && approvalOk && blockers.length === 0) {
      await client.query(sql);
      applied = true;
    }

    postColumns = {};
    for (const v of VIEWS) {
      postColumns[v] = await viewColumns(client, v);
    }
    packageCodeExists = postColumns.v_inventory_item_status?.includes("package_code") ?? false;

    let proofMd = "# package_code query proof\n\n";
    if (applied && packageCodeExists) {
      const pkg = await client.query(
        `SELECT package_code, organization_id, tracking_number, id_slip_contents
         FROM public.packages
         WHERE deleted_at IS NULL AND package_code IS NOT NULL AND btrim(package_code) <> ''
         LIMIT 1`,
      );
      if (pkg.rows[0]) {
        const code = String(pkg.rows[0].package_code);
        const org = pkg.rows[0].organization_id;
        const rows = await client.query(
          `SELECT tracking_number, slip_code, package_code, sku, total_scanned, total_expected
           FROM public.v_inventory_item_status
           WHERE organization_id = $1 AND package_code = $2
           LIMIT 5`,
          [org, code],
        );
        proofMd += `Sample package_code: \`${code}\`\n\nRows returned: ${rows.rowCount}\n\n`;
        proofMd += "```json\n" + JSON.stringify(rows.rows, null, 2) + "\n```\n";
        queryProof = (rows.rowCount ?? 0) > 0 ? "PASS" : "PARTIAL";
        if (queryProof === "PARTIAL") {
          proofMd +=
            "\n**PARTIAL:** column exists but no matching view rows (expected-only lines or package not yet scanned into return_items).\n";
        }
      } else {
        proofMd += "No packages row with package_code found for query test.\n";
        queryProof = "PARTIAL";
      }
    } else {
      proofMd += "Apply did not run or package_code column missing.\n";
    }
    fs.writeFileSync(path.join(outDir, "package-code-query-proof.md"), proofMd);

    await client.end();
  }

  fs.writeFileSync(
    path.join(outDir, "post-apply-columns.md"),
    [
      "# Post-apply columns",
      "",
      "```json",
      JSON.stringify(postColumns, null, 2),
      "```",
      "",
      `v_inventory_item_status.package_code present: **${packageCodeExists ? "YES" : "NO"}**`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# Apply result — MAIN V205",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| run_id | ${runId} |`,
      `| staging_ref | ${STAGING_REF} |`,
      `| conn_ref | ${connRef ?? "unknown"} |`,
      `| approval_ok | ${approvalOk} |`,
      `| preflight_pass | ${preflight.pass} |`,
      `| apply_requested | ${apply} |`,
      `| applied | ${applied} |`,
      `| package_code on v_inventory_item_status | ${packageCodeExists} |`,
      `| query_proof | ${queryProof} |`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? ["# Blockers", "", ...blockers.map((b) => `- ${b}`)].join("\n")
      : "# Blockers\n\nNone.",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "MAIN V205 — APPLY package_code TO v_inventory_item_status ON STAGING",
        run_id: runId,
        staging_ref: STAGING_REF,
        approval_valid: approvalOk,
        applied,
        package_code_column_exists: packageCodeExists,
        package_code_query_proof: queryProof,
        staging_only: targetOk && notOriginal,
        blockers,
        ddl_path: DDL_PATH,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        outDir,
        approval_valid: approvalOk,
        applied,
        package_code_column_exists: packageCodeExists,
        package_code_query_proof: queryProof,
        blockers,
      },
      null,
      2,
    ),
  );

  if (apply && (!approvalOk || blockers.length > 0)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
