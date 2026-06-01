/**
 * DB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-STAGING-EXECUTE
 *   npx tsx scripts/db-parity-view-linkage-slip-columns-staging-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v3";
const APPROVAL_PATH = ".cursor/operator-approvals/db-parity-view-linkage-slip-columns-staging.md";
const ROGUE_APPROVAL = ".cursor/operator-approvals/.cursor/operator-approvals/db-parity-view-linkage-slip-columns-staging.md";
const RECONCILE_DIR =
  ".cursor/audit-reports/db-parity-view-linkage-column-naming-reconcile/20260530T153000Z";
const SQL_001 = path.join(RECONCILE_DIR, "001_staging_inventory_views_product_linkage.sql");
const SQL_002 = path.join(RECONCILE_DIR, "002_staging_slip_identifier_columns.sql");
const OUT_BASE = ".cursor/audit-reports/db-parity-view-linkage-slip-columns-staging-execute";

const VIEWS = ["v_scanned_items_counted", "v_inventory_item_status", "v_inventory_status"] as const;

const VIEW_REQUIRED_COLS = [
  "resolved_product_id",
  "product_id",
  "product_linkage_status",
  "id_slip_contents",
  "package_code",
  "product_name",
] as const;

const SLIP_REQUIRED_COLS = [
  "upc",
  "fnsku",
  "parsed_asin",
  "parsed_fnsku",
  "parsed_sku",
  "parsed_upc",
  "resolved_product_id",
  "resolved_catalog_product_id",
  "identifier_resolution_status",
  "identifier_resolution_confidence",
] as const;

const FORBIDDEN = [
  /\bINSERT\s+INTO\s+public\.products\b/i,
  /\bINSERT\s+INTO\s+public\.product_identifier_map\b/i,
  /\bpackage_items\b/i,
  /\bkxsvedvpjldygtdbylsy\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
];

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
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

function readApproval(): { ok: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const run = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const ddl = /APPROVED_VIEW_LINKAGE_SLIP_DDL_STAGING\s*=\s*true/i.test(text);
  const ref = text.match(/TARGET_SUPABASE_REF\s*=\s*(\S+)/)?.[1] ?? "";
  return {
    ok: run && ddl && ref === STAGING_REF,
    raw: {
      APPROVED_TO_RUN_STAGING: run ? "true" : "false",
      APPROVED_VIEW_LINKAGE_SLIP_DDL_STAGING: ddl ? "true" : "false",
      TARGET_SUPABASE_REF: ref,
    },
  };
}

function sqlScan(files: string[]): { pass: boolean; hits: string[] } {
  const hits: string[] = [];
  for (const f of files) {
    const sql = fs.readFileSync(path.join(process.cwd(), f), "utf8");
    for (const re of FORBIDDEN) {
      if (re.test(sql)) hits.push(`${f}: ${re.source}`);
    }
  }
  return { pass: hits.length === 0, hits };
}

async function captureViewDefs(client: pg.Client): Promise<string> {
  const parts: string[] = ["-- captured before apply", ""];
  for (const v of VIEWS) {
    const r = await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [`public.${v}`]);
    parts.push(`-- ${v}`, String(r.rows[0]?.def ?? "(missing)"), "");
  }
  return parts.join("\n");
}

async function viewColumns(client: pg.Client, view: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [view],
  );
  return r.rows.map((x: { column_name: string }) => x.column_name);
}

async function tableColumns(client: pg.Client, table: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((x: { column_name: string }) => x.column_name);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const blockers: string[] = [];

  let branch = "unknown";
  try {
    branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    blockers.push("Could not read git branch");
  }
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch ${branch} !== ${REQUIRED_BRANCH}`);

  const approval = readApproval();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const stagingUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const urlRef = refFromSupabaseUrl(url);
  const connRef = refFromConnectionUrl(stagingUrl);
  const connLooksStaging =
    connRef === STAGING_REF || (stagingUrl.includes(STAGING_REF) && urlRef === STAGING_REF);

  if (!approval.ok) blockers.push("Canonical approval flags not true or wrong TARGET_SUPABASE_REF");
  if (urlRef !== STAGING_REF) blockers.push(`NEXT_PUBLIC_SUPABASE_URL ref ${urlRef} !== ${STAGING_REF}`);
  if (!stagingUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  if (!connLooksStaging) blockers.push(`Connection must target staging ${STAGING_REF} (parsed ${connRef ?? "null"})`);
  if (stagingUrl.includes(ORIGINAL_REF)) blockers.push("Connection URL contains original ref — forbidden");

  const scan = sqlScan([SQL_001, SQL_002]);
  if (!scan.pass) blockers.push(...scan.hits.map((h) => `SQL scan: ${h}`));

  for (const f of [SQL_001, SQL_002]) {
    if (!fs.existsSync(path.join(process.cwd(), f))) blockers.push(`Missing ${f}`);
  }

  let normalizeOk = false;
  let beforeViews = "";
  let applied001 = false;
  let applied002 = false;
  let verifyPass = false;
  let viewCols: Record<string, string[]> = {};
  let slipCols: string[] = [];
  const verifyDetails: Record<string, unknown> = {};

  if (stagingUrl && blockers.length === 0 && connLooksStaging) {
    const client = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      const fn = await client.query(
        `SELECT count(*)::int AS n FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('normalize_removal_tracking_operational','normalize_removal_carrier_operational')`,
      );
      normalizeOk = Number(fn.rows[0]?.n) >= 2;

      beforeViews = await captureViewDefs(client);
      fs.writeFileSync(path.join(outDir, "before-view-snapshots.md"), `# Before view snapshots\n\n\`\`\`sql\n${beforeViews}\n\`\`\`\n`);

      if (apply && approval.ok) {
        const sql1 = fs.readFileSync(path.join(process.cwd(), SQL_001), "utf8");
        await client.query(sql1);
        applied001 = true;
        const sql2 = fs.readFileSync(path.join(process.cwd(), SQL_002), "utf8");
        await client.query(sql2);
        applied002 = true;
      }

      for (const v of VIEWS) viewCols[v] = await viewColumns(client, v);
      slipCols = await tableColumns(client, "slip_contents");

      const viewMissing: Record<string, string[]> = {};
      for (const v of VIEWS) {
        const missing = VIEW_REQUIRED_COLS.filter((c) => !viewCols[v]?.includes(c));
        if (missing.length) viewMissing[v] = [...missing];
      }
      const slipMissing = SLIP_REQUIRED_COLS.filter((c) => !slipCols.includes(c));

      const resolvedSample = await client.query(
        `SELECT tracking_number, slip_code, sku, resolved_product_id, product_name, identifier_resolution_status
         FROM public.v_inventory_item_status
         WHERE resolved_product_id IS NOT NULL
         LIMIT 25`,
      );
      const unresolvedSample = await client.query(
        `SELECT tracking_number, slip_code, sku, resolved_product_id, product_name
         FROM public.v_inventory_item_status
         WHERE resolved_product_id IS NULL AND (sku IS NOT NULL OR fnsku IS NOT NULL)
         LIMIT 25`,
      );
      const aliasCheck = await client.query(
        `SELECT slip_code, id_slip_contents
         FROM public.v_inventory_item_status
         WHERE slip_code IS NOT NULL
         LIMIT 10`,
      );
      let aliasOk = true;
      for (const row of aliasCheck.rows as { slip_code: string; id_slip_contents: string }[]) {
        if (row.slip_code !== row.id_slip_contents) aliasOk = false;
      }

      const withName = (resolvedSample.rows as { product_name: string | null }[]).filter(
        (r) => r.product_name != null && String(r.product_name).trim() !== "",
      ).length;

      verifyDetails.view_missing = viewMissing;
      verifyDetails.slip_missing = slipMissing;
      verifyDetails.resolved_sample_count = resolvedSample.rowCount;
      verifyDetails.resolved_with_product_name = withName;
      verifyDetails.unresolved_sample_count = unresolvedSample.rowCount;
      verifyDetails.alias_ok = aliasOk;

      verifyPass =
        applied001 &&
        applied002 &&
        Object.keys(viewMissing).length === 0 &&
        slipMissing.length === 0 &&
        aliasOk;

      const pkg = await client.query(
        `SELECT organization_id, tracking_number, package_code
         FROM public.packages
         WHERE deleted_at IS NULL AND tracking_number IS NOT NULL AND btrim(tracking_number) <> ''
         LIMIT 1`,
      );
      let smokeRows: unknown[] = [];
      if (pkg.rows[0]) {
        const org = pkg.rows[0].organization_id;
        const tn = String(pkg.rows[0].tracking_number).split(",")[0]!.trim();
        const sm = await client.query(
          `SELECT tracking_number, slip_code, id_slip_contents, package_code, sku, fnsku,
                  resolved_product_id, product_id, product_linkage_status, product_name, total_expected, total_scanned
           FROM public.v_inventory_item_status
           WHERE organization_id = $1 AND tracking_number ILIKE $2
           LIMIT 5`,
          [org, `%${tn.slice(0, 12)}%`],
        );
        smokeRows = sm.rows;
      }
      fs.writeFileSync(
        path.join(outDir, "scanner-readonly-smoke.md"),
        [
          "# Scanner read-only smoke",
          "",
          "Read-only SELECT on `v_inventory_item_status` (no mutations).",
          "",
          "```json",
          JSON.stringify(smokeRows, null, 2),
          "```",
        ].join("\n") + "\n",
      );
    } finally {
      await client.end();
    }
  }

  if (!normalizeOk) blockers.push("normalize_removal_* functions missing on staging");

  fs.writeFileSync(
    path.join(outDir, "preflight.md"),
    [
      "# Preflight",
      "",
      `| Check | Result |`,
      `|-------|--------|`,
      `| Branch \`${REQUIRED_BRANCH}\` | ${branch === REQUIRED_BRANCH ? "PASS" : "FAIL"} |`,
      `| Staging ref | ${connRef ?? "n/a"} |`,
      `| Approval | ${approval.ok ? "PASS" : "FAIL"} |`,
      `| Rogue path ignored | ${ROGUE_APPROVAL} |`,
      `| normalize_removal_* | ${normalizeOk ? "PASS" : "FAIL"} |`,
      `| SQL forbidden scan | ${scan.pass ? "PASS" : "FAIL"} |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "approval-validation.md"),
    [
      "# Approval validation",
      "",
      `Canonical: \`${APPROVAL_PATH}\` → **${approval.ok ? "VALID" : "INVALID"}**`,
      "",
      "```text",
      ...Object.entries(approval.raw).map(([k, v]) => `${k}=${v}`),
      "```",
      "",
      `Rogue manual file ignored: \`${ROGUE_APPROVAL}\``,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# Execute result",
      "",
      `| Step | Status |`,
      `|------|--------|`,
      `| 001 views | ${applied001 ? "APPLIED" : apply ? "FAILED/SKIPPED" : "DRY-RUN"} |`,
      `| 002 slip columns | ${applied002 ? "APPLIED" : apply ? "FAILED/SKIPPED" : "DRY-RUN"} |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "verification-result.md"),
    ["# Verification", "", "```json", JSON.stringify(verifyDetails, null, 2), "```"].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-ready.md"),
    [
      "# Rollback ready",
      "",
      "Pre-apply view definitions captured in `before-view-snapshots.md`.",
      "",
      "Restore: re-run captured `CREATE OR REPLACE VIEW` from before apply.",
      "See reconcile rollback: `db-parity-view-linkage-column-naming-reconcile/20260530T153000Z/rollback-staging.sql`.",
    ].join("\n") + "\n",
  );

  const execBlockers = [...blockers];
  if (apply && !applied001) execBlockers.push("001 not applied");
  if (apply && !applied002) execBlockers.push("002 not applied");
  if (apply && !verifyPass) execBlockers.push("Verification failed");

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    execBlockers.length ? execBlockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None\n",
  );

  const status = apply && approval.ok && execBlockers.length === 0 && verifyPass ? "PASS" : apply ? "FAIL" : "BLOCKED";

  fs.writeFileSync(
    path.join(outDir, "exact-next-prompt.md"),
    status === "PASS"
      ? "# Next\n\n```text\nDB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-ORIGINAL-EXECUTE — after operator signs original approval; run reconcile 001+002 on kxsvedvpjldygtdbylsy + 003 indexes\n```\n"
      : "# Next\n\nFix blockers and re-run DB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-STAGING-EXECUTE\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        run_id: runId,
        status,
        approval_valid: approval.ok,
        staging_execute_done: applied001 && applied002,
        views_replaced: applied001,
        slip_columns_added: applied002,
        verification_pass: verifyPass,
        staging_ref: STAGING_REF,
        blockers: execBlockers,
        exact_next_prompt:
          status === "PASS"
            ? "DB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-ORIGINAL-EXECUTE"
            : "DB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-STAGING-EXECUTE-RETRY",
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        status,
        outDir,
        approval_valid: approval.ok,
        views_replaced: applied001,
        slip_columns_added: applied002,
        verification_pass: verifyPass,
        blockers: execBlockers,
      },
      null,
      2,
    ),
  );
  if (apply && status !== "PASS") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
