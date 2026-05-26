/**
 * PC02C — EXPECTED-PACKAGES 404 COHORT MANUAL REVIEW QUEUE
 *
 * Read-only export of PC02A 5-row / 3-ASIN cohort for operator review.
 * No SP-API, no product create, no DB writes.
 *
 *   npx tsx scripts/pc02c-expected-packages-404-cohort-manual-review-queue.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/pc02c-expected-packages-404-cohort-manual-review-queue";
const PC02A_RUN = "20260523T030000Z";
const PC02B_RUN = "20260523T040000Z";

const COHORT_EP_IDS = [
  "654dc645-fb8c-4361-a813-173ef093d934",
  "15e14bfd-e549-4e6d-9195-bd982a1c4160",
  "2b0b7cd8-d94f-488c-9290-f48c93763c33",
  "5ea7a691-3bb0-49b1-9cf1-2e24924ddf4b",
  "01ce4f4a-19de-4ce8-bdb2-8fb9d832b5d5",
] as const;

const COHORT_ASIN_BY_EP: Record<string, string> = {
  "654dc645-fb8c-4361-a813-173ef093d934": "B0CQKPKKCM",
  "15e14bfd-e549-4e6d-9195-bd982a1c4160": "B0CS88T6FR",
  "2b0b7cd8-d94f-488c-9290-f48c93763c33": "B0CS88T6FR",
  "5ea7a691-3bb0-49b1-9cf1-2e24924ddf4b": "B0CS88T6FR",
  "01ce4f4a-19de-4ce8-bdb2-8fb9d832b5d5": "B0DMQCZPQN",
};

type RecommendedAction =
  | "asin_correction"
  | "quarantine_exclude"
  | "dedupe_then_asin_correction";

type QueueRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string;
  build_source: string | null;
  order_id: string | null;
  resolved_product_id: string | null;
  package_code: string | null;
  catalog_http_status: number;
  pc02b_verdict: string;
  resolver_status: string | null;
  resolver_product_id: string | null;
  map_product_ids: string[];
  recommended_action: RecommendedAction;
  operator_note: string;
  priority: number;
};

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function currentBranch(): string {
  try {
    return execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function loadPc02bTriage(): Map<string, { verdict: string; catalog_http_status: number; rationale: string }> {
  const p = path.join(
    process.cwd(),
    ".cursor/audit-reports/pc02b-sp-api-evidence-positive-control-execute",
    PC02B_RUN,
    "cohort-404-triage.json",
  );
  const byAsin = new Map<string, { verdict: string; catalog_http_status: number; rationale: string }>();
  if (!fs.existsSync(p)) return byAsin;
  const rows = JSON.parse(fs.readFileSync(p, "utf8")) as Array<{
    asin: string;
    verdict: string;
    catalog_http_status: number;
    rationale: string;
  }>;
  for (const r of rows) byAsin.set(r.asin, r);
  return byAsin;
}

function duplicateKey(row: { fnsku: string | null; sku: string | null; asin: string }): string {
  return `${(row.fnsku ?? "").trim().toUpperCase()}|${(row.sku ?? "").trim().toUpperCase()}|${row.asin}`;
}

function recommendAction(input: {
  row: QueueRow;
  isDuplicateCluster: boolean;
  hasFnsku: boolean;
  hasSku: boolean;
}): { action: RecommendedAction; note: string; priority: number } {
  const { row, isDuplicateCluster, hasFnsku, hasSku } = input;

  if (!hasFnsku && !hasSku) {
    return {
      action: "quarantine_exclude",
      note: "No FNSKU/SKU to anchor listing lookup — exclude from auto-link until source enriched",
      priority: 3,
    };
  }

  if (isDuplicateCluster) {
    return {
      action: "dedupe_then_asin_correction",
      note:
        "Duplicate expected_packages for same FNSKU/SKU/ASIN cluster — pick one canonical row, quarantine duplicates, then correct ASIN from Seller Central listing for FNSKU",
      priority: 1,
    };
  }

  if (row.catalog_http_status === 404 && row.pc02b_verdict.includes("wrong_marketplace")) {
    return {
      action: "asin_correction",
      note:
        "SP-API NOT_FOUND in ATVPDKIKX0DER; FNSKU/SKU present but no map — verify listing ASIN in Seller Central and correct source ASIN (or quarantine if non-US/delisted)",
      priority: 2,
    };
  }

  return {
    action: "asin_correction",
    note: "Operator verify ASIN against FNSKU listing",
    priority: 2,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, id);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingOk =
    supabaseUrlMatchesStagingRef(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "", STAGING_REF) &&
    getStagingProjectRef({ loadEnv: false }) === STAGING_REF;

  if (!stagingOk) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), "# Blockers\n\nStaging ref guard failed.\n");
    throw new Error("Staging ref guard failed");
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL!.trim();
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '120s'`);

  const colRes = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='expected_packages'`,
  );
  const epCols = new Set(colRes.rows.map((r: { column_name: string }) => r.column_name));
  const packageCodeSel = epCols.has("package_code") ? "NULLIF(TRIM(e.package_code), '')" : "NULL::text";
  const buildSourceSel = epCols.has("build_source") ? "NULLIF(TRIM(e.build_source), '')" : "NULL::text";
  const orderIdSel = epCols.has("order_id") ? "NULLIF(TRIM(e.order_id::text), '')" : "NULL::text";

  const epRes = await client.query(
    `
    SELECT e.id::text AS expected_package_id,
           e.organization_id::text,
           e.store_id::text,
           NULLIF(TRIM(e.sku), '') AS sku,
           NULLIF(TRIM(e.fnsku), '') AS fnsku,
           ${buildSourceSel} AS build_source,
           ${orderIdSel} AS order_id,
           e.resolved_product_id::text,
           ${packageCodeSel} AS package_code
    FROM public.expected_packages e
    WHERE e.id = ANY($1::uuid[])
    ORDER BY e.fnsku, e.sku, e.id
  `,
    [COHORT_EP_IDS],
  );

  const mapRes = await client.query(
    `
    SELECT ep.id::text AS expected_package_id,
           ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS map_product_ids
    FROM public.expected_packages ep
    LEFT JOIN public.product_identifier_map m
      ON m.organization_id = ep.organization_id
     AND m.store_id = ep.store_id
     AND m.deleted_at IS NULL
     AND (
       (ep.fnsku IS NOT NULL AND UPPER(TRIM(m.fnsku)) = UPPER(TRIM(ep.fnsku)))
       OR (ep.sku IS NOT NULL AND UPPER(TRIM(COALESCE(m.seller_sku, m.msku))) = UPPER(TRIM(ep.sku)))
     )
    WHERE ep.id = ANY($1::uuid[])
    GROUP BY ep.id
  `,
    [COHORT_EP_IDS],
  );

  const mapByEp = new Map(
    (mapRes.rows as { expected_package_id: string; map_product_ids: string[] | null }[]).map((r) => [
      r.expected_package_id,
      r.map_product_ids ?? [],
    ]),
  );

  await client.end();

  const triageByAsin = loadPc02bTriage();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const rawRows = epRes.rows as Array<{
    expected_package_id: string;
    organization_id: string;
    store_id: string | null;
    sku: string | null;
    fnsku: string | null;
    build_source: string | null;
    order_id: string | null;
    resolved_product_id: string | null;
    package_code: string | null;
  }>;

  if (rawRows.length !== COHORT_EP_IDS.length) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      `# Blockers\n\nExpected ${COHORT_EP_IDS.length} rows, found ${rawRows.length} on staging.\n`,
    );
    throw new Error(`Cohort row count mismatch: ${rawRows.length}`);
  }

  const prelim = rawRows.map((r) => {
    const asin = COHORT_ASIN_BY_EP[r.expected_package_id] ?? "";
    const triage = triageByAsin.get(asin);
    return {
      ...r,
      asin,
      catalog_http_status: triage?.catalog_http_status ?? 404,
      pc02b_verdict: triage?.verdict ?? "wrong_marketplace_or_catalog_not_found",
      map_product_ids: mapByEp.get(r.expected_package_id) ?? [],
      resolver_status: null as string | null,
      resolver_product_id: null as string | null,
      recommended_action: "asin_correction" as RecommendedAction,
      operator_note: "",
      priority: 2,
    };
  });

  const clusterCounts = new Map<string, number>();
  for (const r of prelim) {
    const k = duplicateKey(r);
    clusterCounts.set(k, (clusterCounts.get(k) ?? 0) + 1);
  }

  const queueRows: QueueRow[] = [];
  for (const r of prelim) {
    const resolver = await resolveScannerProductIdentifiers(sb, {
      organizationId: r.organization_id,
      storeId: r.store_id ?? STORE,
      sku: r.sku,
      asin: r.asin,
      fnsku: r.fnsku,
      upc: null,
      productIdentifier: r.fnsku ?? r.sku ?? r.asin,
    });
    const isDup = (clusterCounts.get(duplicateKey(r)) ?? 0) > 1;
    const rec = recommendAction({
      row: { ...r, resolver_status: resolver.identifier_resolution_status, resolver_product_id: resolver.resolved_product_id, recommended_action: "asin_correction", operator_note: "", priority: 2 },
      isDuplicateCluster: isDup,
      hasFnsku: !!(r.fnsku?.trim()),
      hasSku: !!(r.sku?.trim()),
    });
    queueRows.push({
      ...r,
      resolver_status: resolver.identifier_resolution_status,
      resolver_product_id: resolver.resolved_product_id,
      recommended_action: rec.action,
      operator_note: rec.note,
      priority: rec.priority,
    });
  }

  queueRows.sort((a, b) => a.priority - b.priority || a.expected_package_id.localeCompare(b.expected_package_id));

  const csvHeader = [
    "expected_package_id",
    "organization_id",
    "store_id",
    "fnsku",
    "sku",
    "asin",
    "build_source",
    "order_id",
    "package_code",
    "resolved_product_id",
    "catalog_http_status",
    "pc02b_verdict",
    "resolver_status",
    "resolver_product_id",
    "map_product_ids",
    "recommended_action",
    "priority",
    "operator_note",
  ];

  const csv = [
    csvHeader.join(","),
    ...queueRows.map((r) =>
      [
        r.expected_package_id,
        r.organization_id,
        r.store_id,
        r.fnsku,
        r.sku,
        r.asin,
        r.build_source,
        r.order_id,
        r.package_code,
        r.resolved_product_id,
        r.catalog_http_status,
        r.pc02b_verdict,
        r.resolver_status,
        r.resolver_product_id,
        r.map_product_ids.join(";"),
        r.recommended_action,
        r.priority,
        r.operator_note,
      ]
        .map(csvEscape)
        .join(","),
    ),
  ].join("\n") + "\n";

  fs.writeFileSync(path.join(outDir, "manual-review-queue.csv"), csv);
  fs.writeFileSync(path.join(outDir, "cohort-rows.json"), JSON.stringify(queueRows, null, 2));

  const byAction = new Map<string, number>();
  for (const r of queueRows) {
    byAction.set(r.recommended_action, (byAction.get(r.recommended_action) ?? 0) + 1);
  }

  fs.writeFileSync(
    path.join(outDir, "recommendation-summary.md"),
    [
      "# PC02C — 404 cohort manual review recommendations",
      "",
      `**Run id:** \`${id}\``,
      `**PC02A reference:** \`${PC02A_RUN}\``,
      `**PC02B triage reference:** \`${PC02B_RUN}\``,
      "",
      "## Cohort",
      "",
      "- **5** expected_packages rows",
      "- **3** distinct ASINs (all SP-API 404 in ATVPDKIKX0DER)",
      "",
      "## Recommended actions",
      "",
      ...[...byAction.entries()].map(([k, n]) => `- **${k}:** ${n} row(s)`),
      "",
      "## Per-row",
      "",
      "| expected_package_id | FNSKU | SKU | ASIN | action |",
      "|---------------------|-------|-----|------|--------|",
      ...queueRows.map(
        (r) =>
          `| \`${r.expected_package_id.slice(0, 8)}…\` | ${r.fnsku ?? "—"} | ${r.sku ?? "—"} | \`${r.asin}\` | **${r.recommended_action}** |`,
      ),
      "",
      "## Operator steps",
      "",
      "1. Open `manual-review-queue.csv` — start with `priority=1` (duplicate cluster).",
      "2. For **dedupe_then_asin_correction**: keep one canonical expected_packages row per FNSKU/SKU cluster; quarantine or merge duplicates.",
      "3. For **asin_correction**: look up FNSKU in Seller Central → copy correct US ASIN → fix source import (no auto product create in this prompt).",
      "4. If listing is non-US or delisted with no replacement → **quarantine_exclude**.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof — PC02C",
      "",
      "**Mode:** read-only queue export",
      "",
      "| Operation | Performed |",
      "|-----------|-----------|",
      "| SP-API HTTP | **no** |",
      "| products INSERT | **no** |",
      "| product_identifier_map INSERT | **no** |",
      "| expected_packages UPDATE | **no** |",
      "| Resolver probe (read-only) | yes |",
    ].join("\n"),
  );

  fs.writeFileSync(path.join(outDir, "blockers.md"), "# Blockers\n\nNone — read-only export completed.\n");

  const manifest = {
    prompt: "PC02C-EXPECTED-PACKAGES-404-COHORT-MANUAL-REVIEW-QUEUE",
    run_id: id,
    branch: currentBranch(),
    staging_ref: STAGING_REF,
    pc02a_reference: PC02A_RUN,
    pc02b_reference: PC02B_RUN,
    mode: "read_only",
    row_count: queueRows.length,
    distinct_asins: new Set(queueRows.map((r) => r.asin)).size,
    recommended_actions: Object.fromEntries(byAction),
    forbidden: {
      sp_api: false,
      product_create: false,
      map_insert: false,
      expected_packages_update: false,
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ outDir, ...manifest }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
