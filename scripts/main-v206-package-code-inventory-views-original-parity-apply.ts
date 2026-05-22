/**
 * MAIN V206 — Original/current parity: package_code on inventory views.
 *
 *   npx tsx scripts/main-v206-package-code-inventory-views-original-parity-apply.ts
 *   npx tsx scripts/main-v206-package-code-inventory-views-original-parity-apply.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const STAGING_PROOF_RUN = "20260522T173000Z";
const APPROVAL_PATH =
  ".cursor/operator-approvals/package-code-inventory-views-v204-original-parity-approval.md";
const DDL_PATH_DEFAULT =
  ".cursor/audit-reports/main-v204-package-code-view-ddl-plan/20260522T160000Z/ddl-plan.sql";
const OUT_BASE = ".cursor/audit-reports/main-v206-package-code-inventory-views-original-parity-apply";

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
    package_code_appended:
      /scanned_qty,\s*package_code/i.test(body) || /variance_qty,\s*package_code/i.test(body),
    deleted_at_filter: /\bWHERE\s+r\.deleted_at\s+IS\s+NULL\b/i.test(body),
    no_destructive_ddl: !FORBIDDEN.slice(0, 4).some((re) => re.test(body)),
    no_package_items: !/\bpackage_items\b/i.test(body),
    no_legacy_returns: !/\bFROM\s+public\.returns\b/i.test(body),
    uses_return_items: /\breturn_items\b/i.test(body),
    create_or_replace_view_only: !/\bDROP\s+VIEW\b/i.test(body) && !/\bALTER\s+TABLE\b/i.test(body),
  };
  if (createCount !== 3) notes.push(`Expected 3 CREATE OR REPLACE VIEW, found ${createCount}`);
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks, notes };
}

async function captureRollback(client: pg.Client): Promise<string> {
  const parts: string[] = [
    "-- Rollback captured before MAIN V206 package_code original parity apply",
    `-- original ref: ${ORIGINAL_REF}`,
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
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const prodUrl = process.env.PRODUCTION_DIRECT_POSTGRES_URL?.trim() || "";
  const connRef = refFromConnectionUrl(originalUrl);

  const originalParityDdl = path.join(outDir, "original-parity-ddl.sql");

  const stagingProofPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/main-v205-package-code-v-inventory-item-status-apply",
    STAGING_PROOF_RUN,
    "manifest.json",
  );
  const stagingProofOk =
    fs.existsSync(stagingProofPath) &&
    (() => {
      try {
        const m = JSON.parse(fs.readFileSync(stagingProofPath, "utf8")) as {
          applied?: boolean;
          package_code_column_exists?: boolean;
        };
        return m.applied === true && m.package_code_column_exists === true;
      } catch {
        return false;
      }
    })();

  const approvalOk = approval.run && approval.ddl;
  const targetOk = originalUrl.length > 0 && connRef === ORIGINAL_REF;
  const notStaging = !stagingUrl || originalUrl !== stagingUrl;
  const notMislabeledProd = !prodUrl || prodUrl !== originalUrl;

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — MAIN V206 original parity",
      "",
      `Approval file: \`${APPROVAL_PATH}\``,
      `Staging proof: \`${STAGING_PROOF_RUN}\` → **${stagingProofOk ? "SIGNED_OFF" : "MISSING"}**`,
      "",
      "Required:",
      "",
      "```text",
      "APPROVED_TO_RUN_ORIGINAL=true",
      "APPROVED_TO_APPLY_VIEW_DDL_ORIGINAL=true",
      "```",
      "",
      "Actual:",
      "",
      "```text",
      `APPROVED_TO_RUN_ORIGINAL=${approval.raw.APPROVED_TO_RUN_ORIGINAL}`,
      `APPROVED_TO_APPLY_VIEW_DDL_ORIGINAL=${approval.raw.APPROVED_TO_APPLY_VIEW_DDL_ORIGINAL}`,
      "```",
      "",
      `Result: **${approvalOk ? "APPROVED" : "BLOCKED"}**.`,
    ].join("\n"),
  );

  const blockers: string[] = [];
  if (!stagingProofOk) blockers.push(`Staging proof missing or incomplete: ${STAGING_PROOF_RUN}`);
  if (!approvalOk) blockers.push("Original parity approval flags not both true");
  if (!targetOk) blockers.push(`ORIGINAL_DIRECT_POSTGRES_URL must resolve to ${ORIGINAL_REF}`);
  if (!notStaging) blockers.push("ORIGINAL URL must not equal STAGING_DIRECT_POSTGRES_URL");
  if (!notMislabeledProd) blockers.push("ORIGINAL URL must not equal PRODUCTION_DIRECT_POSTGRES_URL");
  let applied = false;
  let packageCodeExists = false;
  let queryProof: "PASS" | "PARTIAL" | "FAIL" = "FAIL";
  let postColumns: Record<string, string[]> = {};

  if (targetOk && notStaging && originalUrl) {
    const client = new pg.Client({ connectionString: originalUrl });
    await client.connect();
    const preRollback = await captureRollback(client);
    for (const v of VIEWS) {
      fs.writeFileSync(
        path.join(outDir, `pre-${v}.sql`),
        (
          await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [`public.${v}`])
        ).rows[0]?.def ?? "",
      );
    }
    if (!fs.existsSync(originalParityDdl)) {
      const { execSync } = await import("node:child_process");
      execSync(`npx tsx scripts/_v206-build-original-parity-ddl.ts`, {
        cwd: process.cwd(),
        stdio: "inherit",
        env: { ...process.env, V206_RUN_ID: runId },
      });
    }
    const ddlPath = fs.existsSync(originalParityDdl)
      ? originalParityDdl
      : path.join(process.cwd(), DDL_PATH_DEFAULT);
    const sql = fs.readFileSync(ddlPath, "utf8");
    fs.copyFileSync(ddlPath, path.join(outDir, "ddl-used.sql"));
    const preflight = preflightSql(sql);
    if (!preflight.pass) blockers.push("DDL preflight failed");

    fs.writeFileSync(path.join(outDir, "pre-apply-viewdefs.sql"), preRollback);
    fs.writeFileSync(path.join(outDir, "rollback-viewdefs.sql"), preRollback);

    if (apply && approvalOk && blockers.length === 0) {
      await client.query(sql);
      applied = true;
    }

    for (const v of VIEWS) {
      postColumns[v] = await viewColumns(client, v);
    }
    packageCodeExists = postColumns.v_inventory_item_status?.includes("package_code") ?? false;

    let proofMd = "# package_code query proof (original)\n\n";
    if (packageCodeExists) {
      const pkg = await client.query(
        `SELECT package_code, organization_id
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
        proofMd += `Sample: \`${code}\` — rows: ${rows.rowCount}\n\n`;
        proofMd += "```json\n" + JSON.stringify(rows.rows, null, 2) + "\n```\n";
        queryProof = (rows.rowCount ?? 0) > 0 ? "PASS" : "PARTIAL";
      } else {
        proofMd += "No package_code sample on original.\n";
        queryProof = "PARTIAL";
      }
    }
    fs.writeFileSync(path.join(outDir, "package-code-query-proof.md"), proofMd);
    await client.end();
  }

  fs.writeFileSync(
    path.join(outDir, "post-apply-columns.md"),
    `# Post-apply columns (original)\n\n\`\`\`json\n${JSON.stringify(postColumns, null, 2)}\n\`\`\`\n`,
  );
  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# Apply result — MAIN V206",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| original_ref | ${ORIGINAL_REF} |`,
      `| conn_ref | ${connRef ?? "unknown"} |`,
      `| staging_proof | ${STAGING_PROOF_RUN} |`,
      `| applied | ${applied} |`,
      `| package_code on item view | ${packageCodeExists} |`,
      `| query_proof | ${queryProof} |`,
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? `# Blockers\n\n${blockers.map((b) => `- ${b}`).join("\n")}` : "# Blockers\n\nNone.",
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "MAIN V206 — ORIGINAL PARITY package_code inventory views",
        run_id: runId,
        original_ref: ORIGINAL_REF,
        staging_proof_run: STAGING_PROOF_RUN,
        approval_valid: approvalOk,
        applied,
        package_code_column_exists: packageCodeExists,
        package_code_query_proof: queryProof,
        original_only: targetOk && notStaging,
        blockers,
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
        query_proof: queryProof,
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
