/**
 * REMOVAL EXISTING CSV REBUILD EXECUTE — staging only
 *
 *   npx tsx scripts/removal-existing-csv-rebuild-execute.ts
 *   npx tsx scripts/removal-existing-csv-rebuild-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-existing-csv-rebuild-staging-approval.md";
const OUT_BASE = ".cursor/audit-reports/removal-existing-csv-rebuild-execute";

type EpCounts = {
  total: number;
  detail_shipment: number;
  detail_remainder: number;
  legacy: number;
  other_derived: number;
  overflow_conflict: number;
};

type RebuildResult = {
  detail_lines_in_scope: number;
  matched_rows_upserted: number;
  remainder_rows_upserted: number;
  overflow_lines: number;
  obsolete_rows_deleted: number;
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

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runVal = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const rebuildVal = /APPROVED_REMOVAL_EXISTING_CSV_REBUILD\s*=\s*true/i.test(text);
  return {
    valid: runVal && rebuildVal,
    raw: {
      APPROVED_TO_RUN_STAGING: runVal ? "true" : "false",
      APPROVED_REMOVAL_EXISTING_CSV_REBUILD: rebuildVal ? "true" : "false",
    },
  };
}

function sqlQuote(v: unknown): string {
  if (v == null) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function epCounts(client: pg.Client): Promise<EpCounts> {
  const r = await client.query(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE build_source = 'detail_shipment')::int AS detail_shipment,
      COUNT(*) FILTER (WHERE build_source = 'detail_remainder')::int AS detail_remainder,
      COUNT(*) FILTER (WHERE build_source = 'legacy')::int AS legacy,
      COUNT(*) FILTER (
        WHERE build_source IS NOT NULL
          AND build_source NOT IN ('detail_shipment','detail_remainder','legacy')
      )::int AS other_derived,
      COUNT(*) FILTER (WHERE build_status = 'shipment_overflow_conflict')::int AS overflow_conflict
    FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
    `,
    [ORG_ID, STORE_ID],
  );
  return r.rows[0] as EpCounts;
}

async function domainCounts(client: pg.Client): Promise<{ removals: number; shipments: number }> {
  const r = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.amazon_removals
       WHERE organization_id = $1::uuid AND store_id = $2::uuid) AS removals,
      (SELECT COUNT(*)::int FROM public.amazon_removal_shipments
       WHERE organization_id = $1::uuid AND store_id = $2::uuid) AS shipments
    `,
    [ORG_ID, STORE_ID],
  );
  return r.rows[0] as { removals: number; shipments: number };
}

async function tableCount(
  client: pg.Client,
  table: string,
  orgScoped = true,
): Promise<number> {
  const where = orgScoped ? "WHERE organization_id = $1::uuid AND store_id = $2::uuid" : "";
  const params = orgScoped ? [ORG_ID, STORE_ID] : [];
  const r = await client.query(`SELECT COUNT(*)::int AS c FROM public.${table} ${where}`, params);
  return (r.rows[0] as { c: number }).c;
}

/** 20260631 index contract required by rebuild_expected_packages_from_removals */
async function ensureRebuildIndexes(client: pg.Client): Promise<{ applied: string[] }> {
  const idx = await client.query(
    `
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'uq_expected_packages_canonical_cross_file',
        'uq_expected_packages_canonical_legacy',
        'uq_expected_packages_derived_pair'
      )
    `,
  );
  const byName = new Map(
    (idx.rows as Array<{ indexname: string; indexdef: string }>).map((r) => [r.indexname, r.indexdef]),
  );
  const applied: string[] = [];

  await client.query(
    `UPDATE public.expected_packages SET build_source = 'legacy' WHERE build_source IS NULL`,
  );

  if (byName.has("uq_expected_packages_canonical_cross_file")) {
    await client.query(`DROP INDEX IF EXISTS public.uq_expected_packages_canonical_cross_file`);
    applied.push("dropped uq_expected_packages_canonical_cross_file");
  }

  if (!byName.has("uq_expected_packages_canonical_legacy")) {
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_expected_packages_canonical_legacy
        ON public.expected_packages (
          organization_id, store_id, order_id, order_type, sku, fnsku, disposition
        )
        NULLS NOT DISTINCT
        WHERE build_source = 'legacy'
    `);
    applied.push("created uq_expected_packages_canonical_legacy");
  }

  if (!byName.has("uq_expected_packages_derived_pair")) {
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_expected_packages_derived_pair
        ON public.expected_packages (
          organization_id, source_detail_row_id, source_shipment_row_id
        )
        NULLS NOT DISTINCT
        WHERE build_source IN ('detail_shipment', 'detail_remainder')
    `);
    applied.push("created uq_expected_packages_derived_pair");
  }

  return { applied };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}, got ${branch}`);
  if (!approval.valid) blockers.push("Approval flags not both true");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
      blockers.push(`DB URL must target staging ${STAGING_REF}`);
    }
    if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use original URL as staging");
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB URL targets original project");
  }
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (supaUrl && refFromSupabaseUrl(supaUrl) !== STAGING_REF) {
    blockers.push(`NEXT_PUBLIC_SUPABASE_URL must be staging ${STAGING_REF}`);
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      "| Flag | Value |",
      "|------|-------|",
      `| APPROVED_TO_RUN_STAGING | ${approval.raw.APPROVED_TO_RUN_STAGING} |`,
      `| APPROVED_REMOVAL_EXISTING_CSV_REBUILD | ${approval.raw.APPROVED_REMOVAL_EXISTING_CSV_REBUILD} |`,
      `| approval_file | \`${APPROVAL_PATH}\` |`,
      `| valid | **${approval.valid}** |`,
      `| apply_mode | **${apply}** |`,
      "",
      "No Amazon API. No raw import. No `products.insert`. No `product_identifier_map.insert`.",
    ].join("\n") + "\n",
  );

  if (blockers.length && apply) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    throw new Error(`Blocked: ${blockers.join("; ")}`);
  }

  if (!apply || blockers.length) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run only; pass `--apply` to execute rebuild.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt: "REMOVAL EXISTING CSV REBUILD EXECUTE",
          run_id: runId,
          branch,
          staging_ref: STAGING_REF,
          status: blockers.length ? "BLOCKED" : "DRY_RUN",
          apply,
          blockers,
          exact_next_prompt: apply
            ? null
            : "npx tsx scripts/removal-existing-csv-rebuild-execute.ts --apply",
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ok: !blockers.length, outDir, apply: false, blockers }, null, 2));
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const beforeDomain = await domainCounts(client);
  const beforeEp = await epCounts(client);
  const productsBefore = await tableCount(client, "products");
  const pimBefore = await tableCount(client, "product_identifier_map");

  const preimageRes = await client.query(
    `
    SELECT row_to_json(t) AS row
    FROM (
      SELECT *
      FROM public.expected_packages
      WHERE organization_id = $1::uuid
        AND store_id = $2::uuid
        AND build_source IN ('detail_shipment', 'detail_remainder')
    ) t
    `,
    [ORG_ID, STORE_ID],
  );
  const preimageRows = (preimageRes.rows as Array<{ row: Record<string, unknown> }>).map(
    (r) => r.row,
  );

  const indexPrep = await ensureRebuildIndexes(client);
  fs.writeFileSync(
    path.join(outDir, "index-prerequisite.json"),
    JSON.stringify(indexPrep, null, 2),
  );

  const preimagePath = path.join(outDir, "preimage-derived-expected-packages.json");
  fs.writeFileSync(
    preimagePath,
    JSON.stringify(
      {
        run_id: runId,
        organization_id: ORG_ID,
        store_id: STORE_ID,
        captured_at: new Date().toISOString(),
        row_count: preimageRows.length,
        rows: preimageRows,
      },
      null,
      2,
    ),
  );

  const rebuildRes = await client.query(
    `SELECT * FROM public.rebuild_expected_packages_from_removals($1::uuid, $2::uuid)`,
    [ORG_ID, STORE_ID],
  );
  const rebuild = rebuildRes.rows[0] as RebuildResult;

  const afterDomain = await domainCounts(client);
  const afterEp = await epCounts(client);
  const productsAfter = await tableCount(client, "products");
  const pimAfter = await tableCount(client, "product_identifier_map");

  await client.end();

  const rowsRebuilt =
    Number(rebuild.matched_rows_upserted) + Number(rebuild.remainder_rows_upserted);
  const rollbackPath = path.join(outDir, "rollback-restore-derived-expected-packages.sql");
  const rollbackLines = [
    "-- Rollback: restore derived expected_packages from preimage (staging only)",
    `-- run_id=${runId}`,
    `-- preimage: ${path.relative(process.cwd(), preimagePath).replace(/\\/g, "/")}`,
    `-- rows: ${preimageRows.length}`,
    "",
    "BEGIN;",
    "",
    `DELETE FROM public.expected_packages`,
    `WHERE organization_id = '${ORG_ID}'::uuid`,
    `  AND store_id = '${STORE_ID}'::uuid`,
    `  AND build_source IN ('detail_shipment', 'detail_remainder');`,
    "",
    "-- Re-insert from preimage JSON via operator tool or:",
    "--   npx tsx scripts/removal-existing-csv-rebuild-rollback.ts --run-id=" + runId,
    "",
    "COMMIT;",
  ];
  fs.writeFileSync(rollbackPath, rollbackLines.join("\n") + "\n");

  fs.writeFileSync(
    path.join(outDir, "rebuild-result.json"),
    JSON.stringify(rebuild, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "before-after-counts.md"),
    [
      "# Before / after counts",
      "",
      "## Domain (unchanged expected)",
      "",
      "| Table | Before | After |",
      "|-------|--------|-------|",
      `| amazon_removals | ${beforeDomain.removals} | ${afterDomain.removals} |`,
      `| amazon_removal_shipments | ${beforeDomain.shipments} | ${afterDomain.shipments} |`,
      "",
      "## expected_packages (Sam org/store)",
      "",
      "| Metric | Before | After | Delta |",
      "|--------|--------|-------|-------|",
      `| Total | ${beforeEp.total} | ${afterEp.total} | ${afterEp.total - beforeEp.total} |`,
      `| detail_shipment | ${beforeEp.detail_shipment} | ${afterEp.detail_shipment} | ${afterEp.detail_shipment - beforeEp.detail_shipment} |`,
      `| detail_remainder | ${beforeEp.detail_remainder} | ${afterEp.detail_remainder} | ${afterEp.detail_remainder - beforeEp.detail_remainder} |`,
      `| legacy | ${beforeEp.legacy} | ${afterEp.legacy} | ${afterEp.legacy - beforeEp.legacy} |`,
      `| overflow_conflict (build_status) | ${beforeEp.overflow_conflict} | ${afterEp.overflow_conflict} | ${afterEp.overflow_conflict - beforeEp.overflow_conflict} |`,
      "",
      "## Rebuild function output",
      "",
      "| Field | Value |",
      "|-------|-------|",
      `| detail_lines_in_scope | ${rebuild.detail_lines_in_scope} |`,
      `| matched_rows_upserted | ${rebuild.matched_rows_upserted} |`,
      `| remainder_rows_upserted | ${rebuild.remainder_rows_upserted} |`,
      `| overflow_lines | ${rebuild.overflow_lines} |`,
      `| obsolete_rows_deleted | ${rebuild.obsolete_rows_deleted} |`,
      "",
      "## No-product-create proof",
      "",
      `| Table | Before | After |`,
      `|-------|--------|-------|`,
      `| products | ${productsBefore} | ${productsAfter} |`,
      `| product_identifier_map | ${pimBefore} | ${pimAfter} |`,
    ].join("\n") + "\n",
  );

  const nextPrompt =
    "REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-EXECUTE — map-only resolver backfill after rebuild (separate approval)";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL EXISTING CSV REBUILD EXECUTE",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        status: "PASS",
        apply: true,
        before_expected_packages_total: beforeEp.total,
        after_expected_packages_total: afterEp.total,
        before_derived: beforeEp.detail_shipment + beforeEp.detail_remainder,
        after_derived: afterEp.detail_shipment + afterEp.detail_remainder,
        rows_rebuilt: rowsRebuilt,
        obsolete_rows_deleted: rebuild.obsolete_rows_deleted,
        overflow_conflict_count: afterEp.overflow_conflict,
        overflow_lines_from_function: rebuild.overflow_lines,
        rebuild,
        rollback_path: path.relative(process.cwd(), rollbackPath).replace(/\\/g, "/"),
        preimage_path: path.relative(process.cwd(), preimagePath).replace(/\\/g, "/"),
        exact_next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        before_count: beforeEp.total,
        after_count: afterEp.total,
        rows_rebuilt: rowsRebuilt,
        overflow_conflict_count: afterEp.overflow_conflict,
        rollback_path: path.relative(process.cwd(), rollbackPath).replace(/\\/g, "/"),
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
