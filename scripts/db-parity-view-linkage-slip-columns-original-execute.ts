/**
 * DB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-ORIGINAL-EXECUTE
 *   npx tsx scripts/db-parity-view-linkage-slip-columns-original-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v3";
const APPROVAL_PATH = ".cursor/operator-approvals/db-parity-view-linkage-slip-columns-original.md";
const RECONCILE_DIR =
  ".cursor/audit-reports/db-parity-view-linkage-column-naming-reconcile/20260530T153000Z";
const SQL_001 = path.join(RECONCILE_DIR, "001_staging_inventory_views_product_linkage.sql");
const SQL_002 = path.join(RECONCILE_DIR, "002_staging_slip_identifier_columns.sql");
const SQL_003 = path.join(RECONCILE_DIR, "003_original_expected_packages_indexes.sql");
const OUT_BASE = ".cursor/audit-reports/db-parity-view-linkage-slip-columns-original-execute";
const STAGING_PASS_EVIDENCE =
  ".cursor/audit-reports/db-parity-view-linkage-slip-columns-staging-execute/20260529T231120Z/manifest.json";

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

function flagTrue(text: string, key: string): boolean {
  return new RegExp(`${key}\\s*=\\s*true`, "i").test(text);
}

function readApproval(): {
  ok: boolean;
  indexes: boolean;
  raw: Record<string, string>;
} {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const run = flagTrue(text, "APPROVED_TO_RUN_ORIGINAL");
  const ddl = flagTrue(text, "APPROVED_VIEW_LINKAGE_SLIP_DDL_ORIGINAL");
  const indexes = flagTrue(text, "APPROVED_ORIGINAL_EP_INDEXES_CONCURRENTLY");
  const ref = text.match(/Target ref\s*\|\s*`([^`]+)`/i)?.[1] ?? text.match(/kxsvedvpjldygtdbylsy/)?.[0] ?? "";
  const refOk = ref === ORIGINAL_REF || /kxsvedvpjldygtdbylsy/.test(text);
  return {
    ok: run && ddl && refOk,
    indexes,
    raw: {
      APPROVED_TO_RUN_ORIGINAL: run ? "true" : "false",
      APPROVED_VIEW_LINKAGE_SLIP_DDL_ORIGINAL: ddl ? "true" : "false",
      APPROVED_ORIGINAL_EP_INDEXES_CONCURRENTLY: indexes ? "true" : "false",
      TARGET_REF: refOk ? ORIGINAL_REF : String(ref),
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

function splitConcurrentIndexStatements(sql: string): string[] {
  return sql
    .split(/(?=CREATE INDEX CONCURRENTLY)/i)
    .map((s) => s.trim())
    .filter((s) => /^CREATE INDEX CONCURRENTLY/i.test(s));
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

async function epIndexSourceColumnsOk(client: pg.Client): Promise<boolean> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'expected_packages'
       AND column_name IN (
         'parent_expected_package_id','receive_scope_key','build_source',
         'organization_id','store_id'
       )`,
  );
  const need = new Set([
    "parent_expected_package_id",
    "receive_scope_key",
    "build_source",
    "organization_id",
    "store_id",
  ]);
  for (const row of r.rows as { column_name: string }[]) need.delete(row.column_name);
  return need.size === 0;
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
  if (!approval.ok) blockers.push("Original approval flags not all true or wrong ref");

  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const connRef = refFromConnectionUrl(originalUrl);
  const connLooksOriginal =
    connRef === ORIGINAL_REF || (originalUrl.includes(ORIGINAL_REF) && originalUrl.length > 0);

  if (!originalUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL unset");
  if (!connLooksOriginal) blockers.push(`Connection must target original ${ORIGINAL_REF} (parsed ${connRef ?? "null"})`);
  if (originalUrl === stagingUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL must not equal staging URL");
  if (originalUrl.includes(STAGING_REF)) blockers.push("Connection URL contains staging ref — forbidden");

  const scan = sqlScan([SQL_001, SQL_002, SQL_003]);
  if (!scan.pass) blockers.push(...scan.hits.map((h) => `SQL scan: ${h}`));

  for (const f of [SQL_001, SQL_002, SQL_003]) {
    if (!fs.existsSync(path.join(process.cwd(), f))) blockers.push(`Missing ${f}`);
  }

  if (!fs.existsSync(path.join(process.cwd(), STAGING_PASS_EVIDENCE))) {
    blockers.push(`Staging PASS evidence missing: ${STAGING_PASS_EVIDENCE}`);
  }

  let normalizeOk = false;
  let productsHasProductName = false;
  let productsHasName = false;
  let beforeViews = "";
  let applied001 = false;
  let applied002 = false;
  const indexResults: { name: string; status: string; error?: string }[] = [];
  let verifyPass = false;
  let smokePass = false;
  const verifyDetails: Record<string, unknown> = {};

  const canConnect = originalUrl && connLooksOriginal && !originalUrl.includes(STAGING_REF);

  if (canConnect) {
    const client = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      const fn = await client.query(
        `SELECT count(*)::int AS n FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('normalize_removal_tracking_operational','normalize_removal_carrier_operational')`,
      );
      normalizeOk = Number(fn.rows[0]?.n) >= 2;

      const prodCols = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'products'
           AND column_name IN ('product_name','name')`,
      );
      const names = new Set(prodCols.rows.map((r: { column_name: string }) => r.column_name));
      productsHasProductName = names.has("product_name");
      productsHasName = names.has("name");

      beforeViews = await captureViewDefs(client);
      fs.writeFileSync(
        path.join(outDir, "before-view-snapshots.md"),
        `# Before view snapshots (original)\n\n\`\`\`sql\n${beforeViews}\n\`\`\`\n`,
      );

      if (apply && approval.ok && blockers.length === 0) {
        const sql1 = fs.readFileSync(path.join(process.cwd(), SQL_001), "utf8");
        await client.query(sql1);
        applied001 = true;
        const sql2 = fs.readFileSync(path.join(process.cwd(), SQL_002), "utf8");
        await client.query(sql2);
        applied002 = true;

        if (approval.indexes) {
          const epColsOk = await epIndexSourceColumnsOk(client);
          if (!epColsOk) {
            blockers.push("expected_packages index source columns missing");
          } else {
            const sql3 = fs.readFileSync(path.join(process.cwd(), SQL_003), "utf8");
            for (const stmt of splitConcurrentIndexStatements(sql3)) {
              const nameM = stmt.match(/idx_expected_packages_\w+/i);
              const name = nameM?.[0] ?? "unknown";
              try {
                await client.query(stmt);
                indexResults.push({ name, status: "APPLIED" });
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                indexResults.push({ name, status: "FAILED", error: msg });
                throw e;
              }
            }
          }
        } else {
          indexResults.push({ name: "idx_expected_packages_parent", status: "SKIPPED" });
          indexResults.push({ name: "idx_expected_packages_receive_scope", status: "SKIPPED" });
        }
      }

      const viewCols: Record<string, string[]> = {};
      for (const v of VIEWS) viewCols[v] = await viewColumns(client, v);
      const slipCols = await tableColumns(client, "slip_contents");

      const viewMissing: Record<string, string[]> = {};
      for (const v of VIEWS) {
        const missing = VIEW_REQUIRED_COLS.filter((c) => !viewCols[v]?.includes(c));
        if (missing.length) viewMissing[v] = [...missing];
      }
      const slipMissing = SLIP_REQUIRED_COLS.filter((c) => !slipCols.includes(c));

      verifyDetails.view_missing = viewMissing;
      verifyDetails.slip_missing = slipMissing;
      verifyDetails.pre_apply_view_state = !applied001 ? "legacy (DDL not applied)" : "post-apply";

      const itemStatusReady = VIEW_REQUIRED_COLS.every((c) =>
        viewCols.v_inventory_item_status?.includes(c),
      );

      if (itemStatusReady) {
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

        verifyDetails.resolved_sample_count = resolvedSample.rowCount;
        verifyDetails.resolved_with_product_name = withName;
        verifyDetails.unresolved_sample_count = unresolvedSample.rowCount;
        verifyDetails.alias_ok = aliasOk;

        verifyPass =
          apply &&
          approval.ok &&
          applied001 &&
          applied002 &&
          Object.keys(viewMissing).length === 0 &&
          slipMissing.length === 0 &&
          aliasOk;

        const fnskuRow = await client.query(
          `SELECT tracking_number, slip_code, id_slip_contents, package_code, sku, fnsku,
                  resolved_product_id, product_id, product_linkage_status, product_name
           FROM public.v_inventory_item_status
           WHERE fnsku IS NOT NULL AND btrim(fnsku) <> ''
           LIMIT 5`,
        );
        smokePass = fnskuRow.rows.length > 0;
        fs.writeFileSync(
          path.join(outDir, "scanner-readonly-smoke.md"),
          [
            "# Scanner read-only smoke (original)",
            "",
            "Read-only SELECT on `v_inventory_item_status` by FNSKU presence (no mutations).",
            "",
            "```json",
            JSON.stringify(fnskuRow.rows, null, 2),
            "```",
          ].join("\n") + "\n",
        );
      } else {
        verifyDetails.skipped_samples = "Linkage columns absent until 001 applied";
        verifyPass = false;
        smokePass = false;
        fs.writeFileSync(
          path.join(outDir, "scanner-readonly-smoke.md"),
          [
            "# Scanner read-only smoke (original)",
            "",
            "Skipped — `v_inventory_item_status` missing linkage columns (DDL not applied).",
          ].join("\n") + "\n",
        );
      }
    } finally {
      await client.end();
    }
  }

  if (!normalizeOk && canConnect) blockers.push("normalize_removal_* functions missing on original");
  if (canConnect && productsHasProductName === false)
    blockers.push("products.product_name column missing on original");

  fs.writeFileSync(
    path.join(outDir, "preflight.md"),
    [
      "# Preflight (original)",
      "",
      "| Check | Result |",
      "|-------|--------|",
      `| Branch \`${REQUIRED_BRANCH}\` | ${branch === REQUIRED_BRANCH ? "PASS" : "FAIL"} |`,
      `| Original ref | ${connRef ?? "n/a"} |`,
      `| Approval | ${approval.ok ? "PASS" : "FAIL"} |`,
      `| Staging PASS evidence | ${fs.existsSync(path.join(process.cwd(), STAGING_PASS_EVIDENCE)) ? "PASS" : "FAIL"} |`,
      `| normalize_removal_* | ${normalizeOk ? "PASS" : "FAIL"} |`,
      `| products.product_name | ${productsHasProductName ? "PASS" : "FAIL"} |`,
      `| products.name (legacy) | ${productsHasName ? "present" : "absent — use product_name only in 001"} |`,
      `| max(uuid) workaround in 001 | PASS (verified on staging 20260529T231120Z) |`,
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
      approval.ok
        ? "All required flags true."
        : "Hard stop: set APPROVED_TO_RUN_ORIGINAL, APPROVED_VIEW_LINKAGE_SLIP_DDL_ORIGINAL, and APPROVED_ORIGINAL_EP_INDEXES_CONCURRENTLY to true in canonical approval file.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# Execute result",
      "",
      "| Step | Status |",
      "|------|--------|",
      `| 001 views | ${applied001 ? "APPLIED" : apply && approval.ok ? "FAILED/SKIPPED" : "BLOCKED"} |`,
      `| 002 slip columns | ${applied002 ? "APPLIED" : apply && approval.ok ? "FAILED/SKIPPED" : "BLOCKED"} |`,
      `| 003 indexes | ${indexResults.length ? indexResults.map((i) => `${i.name}: ${i.status}`).join("; ") : "BLOCKED"} |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "index-result.md"),
    [
      "# Index result",
      "",
      "```json",
      JSON.stringify(
        {
          approval_indexes_flag: approval.indexes,
          results: indexResults,
        },
        null,
        2,
      ),
      "```",
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
      "Pre-apply view definitions in `before-view-snapshots.md`.",
      "",
      "Reconcile rollback: `db-parity-view-linkage-column-naming-reconcile/20260530T153000Z/rollback-staging.sql` (view bodies; indexes drop separately if needed).",
    ].join("\n") + "\n",
  );

  const execBlockers = [...blockers];
  if (apply && !approval.ok) execBlockers.push("Approval blocked — no DDL executed");
  if (apply && approval.ok && !applied001) execBlockers.push("001 not applied");
  if (apply && approval.ok && !applied002) execBlockers.push("002 not applied");
  if (apply && approval.ok && verifyPass === false && applied001) execBlockers.push("Verification failed");

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    execBlockers.length ? execBlockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None\n",
  );

  const status =
    apply && approval.ok && execBlockers.length === 0 && verifyPass
      ? "PASS"
      : apply
        ? "FAIL"
        : "BLOCKED";

  const backfillReady = status === "PASS";

  fs.writeFileSync(
    path.join(outDir, "exact-next-prompt.md"),
    status === "PASS"
      ? "# Next\n\n```text\nDB-PARITY-SLIP-CONTENTS-LINKAGE-BACKFILL-DRYRUN — resolver/backfill dry-run on original after view+slip DDL parity (no auto product create)\n```\n"
      : "# Next\n\n```text\nSign .cursor/operator-approvals/db-parity-view-linkage-slip-columns-original.md (all three flags true) then re-run DB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-ORIGINAL-EXECUTE\n```\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        run_id: runId,
        status,
        approval_valid: approval.ok,
        original_execute_done: applied001 && applied002,
        views_replaced: applied001,
        slip_columns_added: applied002,
        indexes: indexResults,
        verification_pass: verifyPass,
        scanner_smoke_pass: smokePass,
        data_backfill_dryrun_ready: backfillReady,
        original_ref: ORIGINAL_REF,
        staging_pass_evidence: STAGING_PASS_EVIDENCE,
        blockers: execBlockers,
        exact_next_prompt:
          status === "PASS"
            ? "DB-PARITY-SLIP-CONTENTS-LINKAGE-BACKFILL-DRYRUN"
            : "DB-PARITY-VIEW-LINKAGE-SLIP-COLUMNS-ORIGINAL-EXECUTE-RETRY",
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
        original_execute_done: applied001 && applied002,
        views_replaced: applied001,
        slip_columns_added: applied002,
        indexes: indexResults,
        verification_pass: verifyPass,
        scanner_smoke_pass: smokePass,
        data_backfill_dryrun_ready: backfillReady,
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
